package app.svarla.domain.call

import android.media.AudioManager
import android.media.ToneGenerator
import android.util.Log
import app.svarla.data.local.dao.CallHistoryDao
import app.svarla.data.local.entity.CallHistoryEntry
import app.svarla.data.local.entity.CallType
import app.svarla.data.remote.AuthManager
import app.svarla.data.remote.api.CallsApi
import app.svarla.data.remote.dto.WebSocketEvent
import app.svarla.data.remote.sync.SyncConnectionState
import app.svarla.data.remote.sync.SyncManager
import app.svarla.domain.audio.AudioDevice
import app.svarla.domain.audio.AudioRouter
import app.svarla.domain.notifications.MissedCallNotifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.webrtc.IceCandidate
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages voice call lifecycle using WebRTC audio via the MediaBridge.
 *
 * Responsibilities:
 * - Call state machine (IDLE → DIALING/RINGING → CONNECTED → ENDED)
 * - Outbound call initiation: POST /calls/make → createOffer → POST /calls/webrtc/offer → setRemoteAnswer
 * - Inbound call answer: POST /calls/answer → createOffer → POST /calls/webrtc/offer → setRemoteAnswer
 * - 30-second timeout for unanswered outbound calls
 * - WebRTC connectionState monitoring for connectivity loss → CONNECTIVITY_LOST
 * - Exposes call state via StateFlow for UI observation
 * - Elapsed duration flow for active calls
 *
 * This class is fully provider-agnostic: no logic branches based on telephony provider type.
 *
 * Requirements covered: 1.2, 1.3, 1.4, 2.8, 12.1, 12.3
 */
@Singleton
class VoiceCallManager @Inject constructor(
    private val callsApi: CallsApi,
    private val syncManager: SyncManager,
    private val authManager: AuthManager,
    private val networkMonitor: NetworkMonitor,
    private val webRtcAudioClient: WebRtcAudioClient,
    private val audioRouter: AudioRouter,
    private val callServiceController: CallServiceController,
    private val callHistoryDao: CallHistoryDao,
    private val missedCallNotifier: MissedCallNotifier,
    private val incomingCallRinger: IncomingCallRinger,
    private val json: Json
) {
    companion object {
        private const val TAG = "VoiceCallManager"
        private const val OUTBOUND_TIMEOUT_MS = 30_000L
        private const val INBOUND_TIMEOUT_MS = 45_000L
        private const val DURATION_UPDATE_INTERVAL_MS = 1000L
        private const val RESET_TO_IDLE_DELAY_MS = 3000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val _callState = MutableStateFlow(CallState())
    /** Observable call state for UI consumption. */
    val callState: StateFlow<CallState> = _callState.asStateFlow()

    private val _elapsedDurationSeconds = MutableStateFlow(0L)
    /** Elapsed call duration in seconds, updated every second while connected. */
    val elapsedDurationSeconds: StateFlow<Long> = _elapsedDurationSeconds.asStateFlow()

    /** Whether the microphone is currently muted. Proxied from AudioRouter. */
    val isMuted: StateFlow<Boolean> = audioRouter.isMuted

    /** Whether the speaker is currently enabled. Proxied from AudioRouter. */
    val isSpeakerOn: StateFlow<Boolean> = audioRouter.isSpeakerOn

    /** The current audio output device. Proxied from AudioRouter. */
    val currentAudioDevice: StateFlow<AudioDevice> = audioRouter.currentAudioDevice

    /** The set of currently available audio devices. Proxied from AudioRouter. */
    val availableDevices: StateFlow<Set<AudioDevice>> = audioRouter.availableDevices

    private var timeoutJob: Job? = null
    private var inboundTimeoutJob: Job? = null
    private var durationJob: Job? = null
    private var networkMonitorJob: Job? = null
    private var eventListenerJob: Job? = null
    private var webRtcStateJob: Job? = null
    private var resetToIdleJob: Job? = null
    private var ringbackToneGenerator: ToneGenerator? = null
    private var ringbackJob: Job? = null

    /**
     * When true, suppresses the missed call notification for the current inbound call.
     * Set when the user explicitly answers or declines. This prevents race conditions
     * where a WebSocket disconnect event arrives and triggers a "missed" notification
     * even though the user took action.
     */
    private var userActedOnInboundCall = false

    /** Tracks call IDs that the user explicitly declined to override server-side "MISSED" classification. */
    private val declinedCallIds = mutableSetOf<String>()

    /** Tracks recently declined calls by phone number + timestamp for fallback matching. */
    private data class DeclinedCallRecord(val phoneNumber: String, val timestamp: Long)
    private val recentlyDeclinedCalls = mutableListOf<DeclinedCallRecord>()

    /**
     * Returns true if the given call ID was explicitly declined by the user.
     * Used by NotificationHandler and CallHistoryViewModel to suppress missed call
     * notifications and history overrides for declined calls.
     */
    fun wasCallDeclined(callId: String): Boolean {
        return declinedCallIds.contains(callId)
    }

    /**
     * Returns true if the given phone number was recently declined (within the last 2 minutes).
     * Fallback match for when callIds don't align between local and server.
     */
    fun wasRecentCallDeclinedFrom(phoneNumber: String): Boolean {
        val now = System.currentTimeMillis()
        // Clean up old records (older than 2 minutes)
        recentlyDeclinedCalls.removeAll { (now - it.timestamp) > 120_000L }
        return recentlyDeclinedCalls.any { it.phoneNumber == phoneNumber }
    }

    init {
        observeWebSocketEvents()
        observeWebRtcConnectionState()
        // Poll active calls on WebSocket connect/reconnect for late-joining awareness
        observeConnectionStateForActiveCalls()
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Initiate an outbound call.
     *
     * Flow: POST /calls/make → get callId → createOffer() → POST /calls/webrtc/offer → setRemoteAnswer(sdpAnswer)
     *
     * @param from The provider number to use as caller ID (E.164)
     * @param to The destination phone number (E.164 or local format)
     */
    fun makeCall(from: String, to: String) {
        if (_callState.value.status != CallStatus.IDLE) {
            Log.w(TAG, "Cannot make call: not in IDLE state (current: ${_callState.value.status})")
            return
        }

        val normalizedTo = normalizeToE164(to, from)
        Log.d(TAG, "Initiating outbound call from=$from to=$normalizedTo (raw input: $to)")

        val callInfo = ActiveCallInfo(
            callId = "", // Will be set when backend responds
            remoteNumber = normalizedTo,
            providerNumber = from,
            startTime = System.currentTimeMillis(),
            isInbound = false
        )

        _callState.value = CallState(
            status = CallStatus.DIALING,
            activeCallInfo = callInfo
        )

        // Route outbound call through Telecom_Path (auto-falls back to Legacy_Path)
        callServiceController.handleOutgoingCallViaTelecom(normalizedTo)

        startNetworkMonitoring()
        startOutboundTimeout()

        scope.launch {
            try {
                initiateOutboundCall(from, normalizedTo)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to initiate call", e)
                endCallInternal(CallEndReason.FAILED, "Call setup failed: ${e.message}")
            }
        }
    }

    /**
     * Answer an inbound call.
     *
     * Flow: POST /calls/answer → createOffer() → POST /calls/webrtc/offer → setRemoteAnswer()
     *
     * @param callId The call ID to answer
     */
    fun answerCall(callId: String) {
        val currentState = _callState.value
        if (currentState.status != CallStatus.RINGING) {
            Log.w(TAG, "Cannot answer call: not in RINGING state (current: ${currentState.status})")
            return
        }

        Log.d(TAG, "Answering inbound call: $callId")

        // Cancel the inbound timeout since user took action
        cancelInboundTimeout()

        // Stop ringing/vibration since user took action
        incomingCallRinger.stop()

        // Suppress missed call notification — user explicitly answered
        userActedOnInboundCall = true

        scope.launch {
            try {
                // Step 1: Tell the server we're answering the call
                Log.d(TAG, "Requesting server to answer call: $callId")
                val response = callsApi.answerCall(callId, app.svarla.data.remote.dto.AnswerCallRequest(deviceId = getDeviceId()))

                if (response.success) {
                    // Step 2: Create WebRTC offer
                    val sdpOffer = webRtcAudioClient.createOffer()
                    Log.d(TAG, "Created SDP offer for inbound call $callId")

                    // Step 3: Submit offer to server and get SDP answer
                    val offerResponse = callsApi.submitWebRtcOffer(callId, sdpOffer)
                    Log.d(TAG, "Received SDP answer for inbound call $callId")

                    // Step 4: Set remote answer to establish WebRTC connection
                    webRtcAudioClient.setRemoteAnswer(offerResponse.sdpAnswer)

                    // Step 4b: Add ICE candidates from the server (MediaBridge uses ICE Lite)
                    for (candidateDto in offerResponse.iceCandidates) {
                        val iceCandidate = IceCandidate(
                            candidateDto.sdpMid ?: "0",
                            candidateDto.sdpMLineIndex,
                            candidateDto.candidate
                        )
                        webRtcAudioClient.addIceCandidate(iceCandidate)
                    }

                    // Transition to CONNECTED
                    val connectedTime = System.currentTimeMillis()
                    _callState.value = currentState.copy(
                        status = CallStatus.CONNECTED,
                        activeCallInfo = currentState.activeCallInfo?.copy(
                            connectedTime = connectedTime
                        )
                    )

                    // Update foreground service notification to "On call"
                    callServiceController.updateConnected(currentState.activeCallInfo?.remoteNumber ?: "")
                    // Notify Telecom framework of CONNECTED state
                    callServiceController.notifyCallConnected()
                    startDurationTimer()
                    startNetworkMonitoring()
                    // Start audio routing after WebRTC session is established
                    audioRouter.startCallAudioRouting(telecomManaged = callServiceController.isTelecomPathActive)
                } else {
                    Log.e(TAG, "Server rejected answer: ${response.errorReason}")
                    endCallInternal(CallEndReason.FAILED, response.errorReason ?: "Failed to answer call")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error answering call", e)
                endCallInternal(CallEndReason.FAILED, "Failed to answer: ${e.message}")
            }
        }
    }

    /**
     * Decline an inbound call.
     *
     * Notifies the server and transitions to ENDED.
     *
     * @param callId The call ID to decline
     * Requirements: 7.4
     */
    fun declineCall(callId: String) {
        val currentState = _callState.value
        if (currentState.status != CallStatus.RINGING) {
            Log.w(TAG, "Cannot decline call: not in RINGING state (current: ${currentState.status})")
            return
        }

        Log.d(TAG, "Declining inbound call: $callId")

        // Cancel the inbound timeout since user took action
        cancelInboundTimeout()

        // Stop ringing/vibration since user took action
        incomingCallRinger.stop()

        // Suppress missed call notification — user explicitly declined
        userActedOnInboundCall = true

        // Track that this call was explicitly declined by the user so the
        // server-side "MISSED" classification can be overridden during sync.
        declinedCallIds.add(callId)

        // Record the declined call for fallback matching by phone number
        val callerNumber = currentState.activeCallInfo?.remoteNumber
        if (!callerNumber.isNullOrEmpty()) {
            recentlyDeclinedCalls.add(DeclinedCallRecord(callerNumber, System.currentTimeMillis()))
        }

        scope.launch {
            try {
                // Tell the server to hang up the call
                callsApi.declineCall(callId)
            } catch (e: Exception) {
                Log.e(TAG, "Error declining call via server (proceeding anyway)", e)
            }
            endCallInternal(CallEndReason.DECLINED)
        }
    }

    /**
     * End the currently active call.
     */
    fun endCall() {
        val currentState = _callState.value
        if (currentState.status == CallStatus.IDLE || currentState.status == CallStatus.ENDED) {
            Log.w(TAG, "Cannot end call: already in ${currentState.status} state")
            return
        }

        Log.d(TAG, "Ending call locally")

        // End the call state FIRST so that the WebRTC observer doesn't race and
        // report CONNECTIVITY_LOST when we intentionally close the peer connection.
        endCallInternal(CallEndReason.LOCAL_HANGUP)

        scope.launch {
            try {
                // Disconnect WebRTC session
                webRtcAudioClient.disconnect()
            } catch (e: Exception) {
                Log.e(TAG, "Error disconnecting WebRTC session", e)
            }

            // Also end the call via server API (ensures the PSTN leg is terminated)
            val callId = currentState.activeCallInfo?.callId
            if (!callId.isNullOrEmpty()) {
                try {
                    callsApi.declineCall(callId)
                } catch (e: Exception) {
                    Log.e(TAG, "Error ending call via server API", e)
                }
            }
        }
    }

    /**
     * Reset to idle state after the UI has acknowledged the ended state.
     */
    fun resetToIdle() {
        resetToIdleJob?.cancel()
        resetToIdleJob = null
        _callState.value = CallState(status = CallStatus.IDLE)
        _elapsedDurationSeconds.value = 0L
    }

    /**
     * Toggle microphone mute state during an active call.
     * Ignored if no call is currently connected.
     *
     * Delegates to AudioRouter for system-level mute and to
     * WebRtcAudioClient for WebRTC track-level mute.
     *
     * Requirements: 9.1, 9.5
     */
    fun toggleMute() {
        if (_callState.value.status != CallStatus.CONNECTED) {
            Log.w(TAG, "toggleMute ignored: not in CONNECTED state (current: ${_callState.value.status})")
            return
        }

        audioRouter.toggleMute()
        webRtcAudioClient.setMuted(audioRouter.isMuted.value)
    }

    /**
     * Toggle speaker on/off during an active call.
     * Ignored if no call is currently connected.
     *
     * Delegates to AudioRouter for system-level speaker routing.
     * WebRTC audio transport is unaffected by speaker routing (it's a local output path change).
     *
     * Requirements: 9.2, 9.5
     */
    fun toggleSpeaker() {
        if (_callState.value.status != CallStatus.CONNECTED) {
            Log.w(TAG, "toggleSpeaker ignored: not in CONNECTED state (current: ${_callState.value.status})")
            return
        }

        audioRouter.toggleSpeaker()
    }

    /**
     * Manually select a specific audio output device.
     * Ignored if no call is currently connected.
     */
    fun selectAudioDevice(device: AudioDevice) {
        if (_callState.value.status != CallStatus.CONNECTED && _callState.value.status != CallStatus.DIALING) {
            Log.w(TAG, "selectAudioDevice ignored: not in active call state (current: ${_callState.value.status})")
            return
        }

        audioRouter.routeToDevice(device)
    }

    /**
     * Send a DTMF tone to the remote party during an active call.
     * Ignored if no call is currently connected.
     *
     * Uses in-band RTP telephone-event (RFC 2833) via WebRTC as primary path,
     * with an out-of-band REST API fallback if in-band fails.
     *
     * @param digit The DTMF character to send (0-9, *, #)
     * Requirements: 12.1
     */
    fun sendDtmf(digit: Char) {
        if (_callState.value.status != CallStatus.CONNECTED) {
            Log.w(TAG, "sendDtmf ignored: not in CONNECTED state (current: ${_callState.value.status})")
            return
        }

        // Primary: in-band DTMF via WebRTC RTCDTMFSender
        try {
            webRtcAudioClient.sendDtmf(digit)
            Log.d(TAG, "Sent DTMF '$digit' via in-band WebRTC")
        } catch (e: Exception) {
            Log.w(TAG, "In-band DTMF failed for '$digit', falling back to REST API", e)
            // Fallback: out-of-band DTMF via REST API
            val callId = _callState.value.activeCallInfo?.callId
            if (!callId.isNullOrEmpty()) {
                scope.launch {
                    try {
                        callsApi.sendDtmf(callId, digit)
                        Log.d(TAG, "Sent DTMF '$digit' via REST fallback")
                    } catch (restError: Exception) {
                        Log.e(TAG, "REST DTMF fallback also failed for '$digit'", restError)
                    }
                }
            }
        }
    }

    // ========================================================================
    // Inbound call handling (from WebSocket events)
    // ========================================================================

    /**
     * Handle an incoming call event from the server.
     * Called when a WebSocket `call_event` with status="ringing" is received.
     *
     * Starts a 45-second inbound timeout. If no user action (answer/decline)
     * or remote disconnect occurs within that period, the call ends with TIMEOUT.
     *
     * Requirements: 7.1, 7.7
     */
    internal fun handleIncomingCall(
        callId: String,
        fromNumber: String,
        providerNumber: String,
        providerNumberLabel: String?
    ) {
        val currentState = _callState.value

        // If already RINGING, enrich/update the call info with richer details.
        // The Telecom path initially sets state with minimal info from the push wake signal
        // (using the notification UUID as a temporary callId and empty caller info);
        // the notification fetch or WebSocket event provides the full caller details and
        // the real server callId later. We always allow updating when in RINGING state
        // because callers (NotificationHandler, WebSocket handler) validate call identity
        // before invoking this method.
        if (currentState.status == CallStatus.RINGING && currentState.activeCallInfo != null) {
            val existingCallId = currentState.activeCallInfo.callId
            if (existingCallId == callId) {
                Log.d(TAG, "Incoming call $callId: enriching call info (from=$fromNumber, provider=$providerNumber)")
            } else {
                Log.d(TAG, "Incoming call $callId: replacing temp callId=$existingCallId with real callId (from=$fromNumber, provider=$providerNumber)")
            }
            val updatedInfo = currentState.activeCallInfo.copy(
                callId = callId,
                remoteNumber = fromNumber.ifEmpty { currentState.activeCallInfo.remoteNumber },
                providerNumber = providerNumber.ifEmpty { currentState.activeCallInfo.providerNumber },
                providerNumberLabel = providerNumberLabel ?: currentState.activeCallInfo.providerNumberLabel
            )
            _callState.value = currentState.copy(activeCallInfo = updatedInfo)
            return
        }

        if (currentState.status != CallStatus.IDLE && currentState.status != CallStatus.ENDED) {
            Log.w(TAG, "Incoming call $callId ignored: not in IDLE state (current: ${currentState.status})")
            return
        }

        // If we're in ENDED state (waiting for auto-reset to IDLE), cancel the pending
        // reset and proceed — a new incoming call takes priority.
        if (currentState.status == CallStatus.ENDED) {
            Log.d(TAG, "Incoming call $callId: pre-empting ENDED state for new incoming call")
            resetToIdleJob?.cancel()
            resetToIdleJob = null
        }

        Log.d(TAG, "Incoming call: $callId from=$fromNumber on=$providerNumber")

        val callInfo = ActiveCallInfo(
            callId = callId,
            remoteNumber = fromNumber,
            providerNumber = providerNumber,
            providerNumberLabel = providerNumberLabel,
            startTime = System.currentTimeMillis(),
            isInbound = true
        )

        _callState.value = CallState(
            status = CallStatus.RINGING,
            activeCallInfo = callInfo
        )

        // Start ringing and vibration immediately when call enters RINGING state.
        // This is the canonical place for starting the ringer regardless of the
        // call path (Telecom_Path or Legacy_Path).
        incomingCallRinger.start()

        // Only route through Telecom if a Telecom connection isn't already active.
        // When SvarlaConnectionService creates the connection first (push → TelecomManager path),
        // it calls handleIncomingCallFromTelecom() which sets state to RINGING without re-routing.
        // This branch handles WebSocket-delivered calls (app in foreground) where no Telecom
        // connection exists yet.
        if (!callServiceController.isTelecomPathActive) {
            try {
                callServiceController.handleIncomingCallViaTelecom(callId, fromNumber)
            } catch (e: Exception) {
                // On Android 12+, this may throw if called from background without exemption.
                // The service was already started by the push receiver in that case.
                Log.w(TAG, "Could not start call service (likely already started): ${e.message}")
            }
        }

        // Start 45-second inbound timeout
        startInboundTimeout()
    }

    /**
     * Transitions VoiceCallManager to RINGING state when the Telecom framework has already
     * created the connection. Called by [SvarlaConnectionService.onCreateIncomingConnection].
     *
     * Unlike [handleIncomingCall], this does NOT attempt to route through TelecomManager
     * (since the connection already exists) and does NOT start the inbound timeout
     * (that is started when [handleIncomingCall] is called with full call metadata from
     * the notification fetch or WebSocket event).
     *
     * This ensures that when subsequent handlers (NotificationHandler, WebSocket) check
     * VoiceCallManager's state, they see RINGING and don't attempt duplicate Telecom routing.
     */
    internal fun handleIncomingCallFromTelecom(callId: String, callerNumber: String) {
        val currentStatus = _callState.value.status
        if (currentStatus != CallStatus.IDLE && currentStatus != CallStatus.ENDED) {
            Log.d(TAG, "handleIncomingCallFromTelecom: already in $currentStatus, updating call info")
            // If already ringing (unlikely), just update the info if needed
            return
        }

        // If we're in ENDED state (waiting for auto-reset to IDLE), cancel the pending
        // reset and proceed — a new incoming call takes priority.
        if (currentStatus == CallStatus.ENDED) {
            Log.d(TAG, "handleIncomingCallFromTelecom: pre-empting ENDED state for new incoming call")
            resetToIdleJob?.cancel()
            resetToIdleJob = null
        }

        Log.d(TAG, "Incoming call via Telecom: $callId from=$callerNumber")

        val callInfo = ActiveCallInfo(
            callId = callId,
            remoteNumber = callerNumber,
            providerNumber = "",
            providerNumberLabel = null,
            startTime = System.currentTimeMillis(),
            isInbound = true
        )

        _callState.value = CallState(
            status = CallStatus.RINGING,
            activeCallInfo = callInfo
        )

        // Start ringing and vibration immediately
        incomingCallRinger.start()

        // Start 45-second inbound timeout
        startInboundTimeout()
    }

    /**
     * Handle a call cancellation event (e.g., answered elsewhere or caller hung up).
     */
    internal fun handleCallCancelled(callId: String, reason: String?) {
        val currentState = _callState.value
        val currentCallId = currentState.activeCallInfo?.callId

        if (currentState.status == CallStatus.IDLE || currentState.status == CallStatus.ENDED) {
            Log.d(TAG, "Call cancelled ignored: not in active state (current: ${currentState.status})")
            return
        }

        // Require callId match to avoid cancelling the wrong call.
        // Vonage sends internal SIP leg events with different UUIDs that should not
        // end the active call.
        if (!currentCallId.isNullOrEmpty() && callId != currentCallId) {
            Log.d(TAG, "Call cancelled for different callId: $callId (active: $currentCallId)")
            return
        }

        // Cancel inbound timeout since remote event occurred
        cancelInboundTimeout()

        val endReason = when (reason) {
            "answered_elsewhere" -> CallEndReason.ANSWERED_ELSEWHERE
            "declined" -> CallEndReason.DECLINED
            "caller_disconnect" -> CallEndReason.REMOTE_HANGUP
            "timeout" -> CallEndReason.TIMEOUT
            else -> CallEndReason.REMOTE_HANGUP
        }

        endCallInternal(endReason)
    }

    // ========================================================================
    // Private implementation
    // ========================================================================

    /**
     * Observe WebRTC connectionState to detect connectivity loss during active calls.
     * When the WebRTC connection to the MediaBridge fails, the call is transitioned
     * to ENDED with reason CONNECTIVITY_LOST.
     *
     * Requirements: 2.8
     */
    private fun observeWebRtcConnectionState() {
        webRtcStateJob = scope.launch {
            webRtcAudioClient.connectionState.collect { state ->
                val currentState = _callState.value
                if (currentState.status == CallStatus.IDLE || currentState.status == CallStatus.ENDED) {
                    return@collect
                }

                when (state) {
                    is WebRtcState.Failed -> {
                        Log.w(TAG, "WebRTC connection failed: ${state.reason} (call state=${currentState.status})")
                        endCallInternal(
                            CallEndReason.CONNECTIVITY_LOST,
                            "Call disconnected: ${state.reason}"
                        )
                    }
                    is WebRtcState.Disconnected -> {
                        // If we're in an active call state and WebRTC disconnects unexpectedly,
                        // treat it as connectivity loss
                        if (currentState.status == CallStatus.CONNECTED ||
                            currentState.status == CallStatus.DIALING
                        ) {
                            Log.w(TAG, "WebRTC disconnected unexpectedly during active call")
                            endCallInternal(
                                CallEndReason.CONNECTIVITY_LOST,
                                "WebRTC connection lost"
                            )
                        }
                    }
                    else -> { /* Connecting or Connected — no action needed */ }
                }
            }
        }
    }

    private fun observeWebSocketEvents() {
        eventListenerJob = scope.launch {
            syncManager.events.collect { event ->
                handleWebSocketEvent(event)
            }
        }
    }

    /**
     * Poll the server for active calls whenever the WebSocket connects or reconnects.
     * This handles the case where the app opens (or reconnects) after a call is already
     * in progress on another device.
     */
    private fun observeConnectionStateForActiveCalls() {
        scope.launch {
            syncManager.connectionState.collect { state ->
                if (state == SyncConnectionState.CONNECTED) {
                    fetchActiveCallsFromServer()
                }
            }
        }
    }

    private suspend fun fetchActiveCallsFromServer() {
        // Only fetch if we're currently idle — don't overwrite an active call state
        if (_callState.value.status != CallStatus.IDLE) return

        try {
            val response = callsApi.getActiveCalls()
            val now = System.currentTimeMillis()

            // Look for connected calls first (another device has an active call)
            val connectedCall = response.calls.firstOrNull { it.status == "connected" }
            if (connectedCall != null && _callState.value.status == CallStatus.IDLE) {
                // Another device has an active call — update state so UI can show banner
                _callState.value = CallState(
                    status = CallStatus.CONNECTED,
                    activeCallInfo = ActiveCallInfo(
                        callId = connectedCall.callId,
                        remoteNumber = connectedCall.from ?: "",
                        providerNumber = connectedCall.providerNumber ?: "",
                        startTime = connectedCall.startedAt ?: System.currentTimeMillis(),
                        connectedTime = connectedCall.startedAt ?: System.currentTimeMillis(),
                        isInbound = true
                    ),
                    endReason = null,
                    errorMessage = null
                )
                return
            }

            // Check for ringing calls — only show if they started recently (within 45s).
            // This prevents showing stale incoming calls that rang while the device was off.
            val ringingCall = response.calls.firstOrNull { it.status == "ringing" }
            if (ringingCall != null && _callState.value.status == CallStatus.IDLE) {
                val callAge = now - (ringingCall.startedAt ?: now)
                if (callAge < INBOUND_TIMEOUT_MS) {
                    // Call is still fresh — show as incoming
                    handleIncomingCall(
                        ringingCall.callId,
                        ringingCall.from ?: "",
                        ringingCall.providerNumber ?: "",
                        null
                    )
                } else {
                    Log.d(TAG, "Stale ringing call ignored: ${ringingCall.callId} (age=${callAge}ms)")
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "Failed to fetch active calls from server: ${e.message}")
        }
    }

    private fun handleWebSocketEvent(event: WebSocketEvent) {
        when (event.type) {
            "call_event" -> {
                val data = event.data?.jsonObject ?: return
                val callId = data["callId"]?.jsonPrimitive?.content ?: return
                val status = data["status"]?.jsonPrimitive?.content ?: return

                when (status) {
                    "ringing" -> {
                        val from = data["from"]?.jsonPrimitive?.content ?: return
                        val providerNumber = data["providerNumber"]?.jsonPrimitive?.content
                            ?: data["vonageNumber"]?.jsonPrimitive?.content ?: ""
                        val providerNumberLabel = data["providerNumberLabel"]?.jsonPrimitive?.content
                            ?: data["vonageNumberLabel"]?.jsonPrimitive?.content
                        handleIncomingCall(callId, from, providerNumber, providerNumberLabel)
                    }
                    "connected" -> handleCallConnected(callId)
                    "disconnected", "completed" -> handleCallDisconnected(callId)
                    "busy" -> handleCallBusy(callId)
                    "failed" -> handleCallFailed(callId)
                }
            }
            "call_cancelled" -> {
                val data = event.data?.jsonObject ?: return
                val callId = data["callId"]?.jsonPrimitive?.content ?: return
                val reason = data["reason"]?.jsonPrimitive?.content
                handleCallCancelled(callId, reason)
            }
            "ice_candidate" -> {
                val data = event.data?.jsonObject ?: return
                val candidate = data["candidate"]?.jsonPrimitive?.content ?: return
                val sdpMid = data["sdpMid"]?.jsonPrimitive?.content ?: "0"
                val sdpMLineIndex = data["sdpMLineIndex"]?.jsonPrimitive?.intOrNull ?: 0

                Log.d(TAG, "Received ICE candidate via WebSocket: sdpMid=$sdpMid, index=$sdpMLineIndex")
                val iceCandidate = IceCandidate(sdpMid, sdpMLineIndex, candidate)
                webRtcAudioClient.addIceCandidate(iceCandidate)
            }
        }
    }

    private fun handleCallConnected(callId: String) {
        val currentState = _callState.value

        // Only auto-transition for DIALING (outbound) calls.
        // For RINGING (inbound) calls, the transition to CONNECTED happens
        // explicitly in answerCall() after the user accepts.
        if (currentState.status != CallStatus.DIALING) {
            return
        }

        val activeInfo = currentState.activeCallInfo ?: return

        // Update callId if it was empty (outbound calls get their ID from server)
        val updatedInfo = if (activeInfo.callId.isEmpty()) {
            activeInfo.copy(callId = callId, connectedTime = System.currentTimeMillis())
        } else {
            activeInfo.copy(connectedTime = System.currentTimeMillis())
        }

        cancelTimeout()
        cancelInboundTimeout()
        stopRingbackTone()
        _callState.value = CallState(
            status = CallStatus.CONNECTED,
            activeCallInfo = updatedInfo
        )
        // Update foreground service notification to "On call"
        callServiceController.updateConnected(updatedInfo.remoteNumber)
        // Notify Telecom framework of CONNECTED state (App → Framework sync)
        callServiceController.notifyCallConnected()
        startDurationTimer()
        audioRouter.startCallAudioRouting(telecomManaged = callServiceController.isTelecomPathActive)
    }

    private fun handleCallDisconnected(callId: String) {
        val currentState = _callState.value

        if (currentState.status == CallStatus.IDLE || currentState.status == CallStatus.ENDED) {
            return
        }

        // Only accept disconnect if the callId matches the active call.
        // Vonage sends internal SIP leg events with different UUIDs that should not
        // end the active call.
        val activeCallId = currentState.activeCallInfo?.callId
        if (!activeCallId.isNullOrEmpty() && callId != activeCallId) {
            Log.d(TAG, "Ignoring disconnect for non-matching callId: $callId (active: $activeCallId)")
            return
        }

        endCallInternal(CallEndReason.REMOTE_HANGUP)
    }

    private fun handleCallBusy(callId: String) {
        val currentState = _callState.value
        if (currentState.status == CallStatus.IDLE || currentState.status == CallStatus.ENDED) {
            return
        }

        val activeCallId = currentState.activeCallInfo?.callId
        if (!activeCallId.isNullOrEmpty() && callId != activeCallId) {
            Log.d(TAG, "Ignoring busy for non-matching callId: $callId (active: $activeCallId)")
            return
        }

        endCallInternal(CallEndReason.REMOTE_HANGUP, "User busy")
    }

    private fun handleCallFailed(callId: String) {
        val currentState = _callState.value
        if (currentState.status == CallStatus.IDLE || currentState.status == CallStatus.ENDED) {
            return
        }

        val activeCallId = currentState.activeCallInfo?.callId
        if (!activeCallId.isNullOrEmpty() && callId != activeCallId) {
            Log.d(TAG, "Ignoring failed for non-matching callId: $callId (active: $activeCallId)")
            return
        }

        endCallInternal(CallEndReason.FAILED, "Call connection failed")
    }

    private fun endCallInternal(reason: CallEndReason, errorMessage: String? = null) {
        cancelTimeout()
        cancelInboundTimeout()
        stopRingbackTone()
        stopDurationTimer()
        stopNetworkMonitoring()

        // Stop ringing/vibration if still active
        incomingCallRinger.stop()

        // Play a short disconnect tone so the user knows the call ended
        // (audible through earpiece when phone is held to ear).
        // Only play for remote-initiated endings, not local hangup.
        if (reason != CallEndReason.LOCAL_HANGUP && reason != CallEndReason.ANSWERED_ELSEWHERE) {
            playDisconnectTone()
        }

        audioRouter.stopCallAudioRouting()

        val currentState = _callState.value

        _callState.value = CallState(
            status = CallStatus.ENDED,
            activeCallInfo = currentState.activeCallInfo,
            endReason = reason,
            errorMessage = errorMessage
        )

        // Notify Telecom framework of ENDED state (App → Framework sync)
        callServiceController.notifyCallEnded(reason)

        // Stop the foreground service — call is over
        callServiceController.stop()

        // Handle missed inbound call notification
        // NOTE: With server-managed notifications, the server handles the incoming_call →
        // missed_call transition and broadcasts a notification_updated event. The
        // NotificationHandler processes that event and shows/updates the missed call
        // notification. We no longer show it directly here to avoid duplicates.
        val callInfo = currentState.activeCallInfo
        if (callInfo != null && callInfo.isInbound && callInfo.connectedTime == null &&
            !userActedOnInboundCall && isMissedCallReason(reason)
        ) {
            Log.d(TAG, "Inbound call missed: callId=${callInfo.callId}, reason=$reason (server handles notification)")
        }

        // Reset the user-acted flag for next call
        userActedOnInboundCall = false

        // Sync call history from server after every call ends.
        // The server is the source of truth for call records (outgoing, missed,
        // unanswered, duration). A short delay allows the server to finalize
        // the call record before we fetch.
        val declinedCallInfo = if (reason == CallEndReason.DECLINED) currentState.activeCallInfo else null
        scope.launch(Dispatchers.IO) {
            try {
                delay(1000)
                val response = callsApi.getCallHistory(page = 1, pageSize = 50)
                response.entries.forEach { dto ->
                    // If the user explicitly declined this call, override the server's
                    // "MISSED" classification with DECLINED. Match by callId or by
                    // phone number + recent timestamp for robustness.
                    val isDeclinedByUser = declinedCallIds.contains(dto.id) ||
                        (declinedCallInfo != null &&
                            dto.phoneNumber == declinedCallInfo.remoteNumber &&
                            dto.callType.uppercase() == "MISSED" &&
                            kotlin.math.abs(
                                (try { java.time.Instant.parse(dto.timestamp).toEpochMilli() } catch (_: Exception) { 0L }) -
                                    declinedCallInfo.startTime
                            ) < 60_000L)

                    val callType = if (isDeclinedByUser && dto.callType.uppercase() == "MISSED") {
                        CallType.DECLINED
                    } else {
                        when (dto.callType.uppercase()) {
                            "MISSED" -> CallType.MISSED
                            "OUTGOING" -> CallType.OUTGOING
                            "UNANSWERED" -> CallType.UNANSWERED
                            "DECLINED" -> CallType.DECLINED
                            "BLOCKED" -> CallType.BLOCKED
                            else -> CallType.INCOMING
                        }
                    }
                    val entry = CallHistoryEntry(
                        id = dto.id,
                        phoneNumber = dto.phoneNumber,
                        providerNumber = dto.providerNumber,
                        callType = callType,
                        timestamp = try {
                            java.time.Instant.parse(dto.timestamp).toEpochMilli()
                        } catch (_: Exception) {
                            try { dto.timestamp.toLong() } catch (_: Exception) { System.currentTimeMillis() }
                        },
                        durationSeconds = dto.durationSeconds,
                        answeredByDevice = dto.answeredByDevice,
                        realCallerNumber = dto.realCallerNumber
                    )
                    callHistoryDao.insert(entry)
                }
                // Clean up old declined call IDs (keep only the last 10)
                if (declinedCallIds.size > 10) {
                    val toRemove = declinedCallIds.take(declinedCallIds.size - 10)
                    declinedCallIds.removeAll(toRemove.toSet())
                }
                Log.d(TAG, "Call history synced after call ended")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to sync call history after call ended", e)
            }
        }

        // Clean up the WebRTC session
        try {
            webRtcAudioClient.disconnect()
        } catch (e: Exception) {
            Log.e(TAG, "Error during WebRTC cleanup disconnect", e)
        }

        // Auto-reset to IDLE after a short delay so the state machine is ready
        // for the next call. This handles the case where no UI is open to call
        // resetToIdle() (e.g., call declined from notification while app is killed).
        // The UI can still observe ENDED briefly for its animation.
        resetToIdleJob?.cancel()
        resetToIdleJob = scope.launch {
            delay(RESET_TO_IDLE_DELAY_MS)
            if (_callState.value.status == CallStatus.ENDED) {
                _callState.value = CallState(status = CallStatus.IDLE)
                _elapsedDurationSeconds.value = 0L
            }
        }

        Log.d(TAG, "Call ended: reason=$reason, error=$errorMessage")
    }

    /**
     * Determines whether the given [CallEndReason] constitutes a missed call.
     * A call is considered missed when it was inbound, rang on this device,
     * and ended without the user answering it locally.
     */
    private fun isMissedCallReason(reason: CallEndReason): Boolean {
        return reason == CallEndReason.TIMEOUT ||
            reason == CallEndReason.REMOTE_HANGUP ||
            reason == CallEndReason.UNANSWERED
    }

    // ========================================================================
    // Timeout handling
    // ========================================================================

    private fun startOutboundTimeout() {
        cancelTimeout()
        timeoutJob = scope.launch {
            delay(OUTBOUND_TIMEOUT_MS)
            val currentState = _callState.value
            if (currentState.status == CallStatus.DIALING) {
                Log.d(TAG, "Outbound call timeout after ${OUTBOUND_TIMEOUT_MS}ms")
                try {
                    webRtcAudioClient.disconnect()
                } catch (e: Exception) {
                    Log.e(TAG, "Error disconnecting WebRTC on timeout", e)
                }
                endCallInternal(CallEndReason.UNANSWERED, "Call not answered")
            }
        }
    }

    /**
     * Starts a 45-second timer for inbound calls in RINGING state.
     * If no user action (answer/decline) or remote disconnect occurs within
     * that time, the call transitions to ENDED with reason TIMEOUT.
     *
     * Requirement: 7.7
     */
    private fun startInboundTimeout() {
        cancelInboundTimeout()
        inboundTimeoutJob = scope.launch {
            delay(INBOUND_TIMEOUT_MS)
            val currentState = _callState.value
            if (currentState.status == CallStatus.RINGING) {
                Log.d(TAG, "Inbound call timeout after ${INBOUND_TIMEOUT_MS}ms")
                endCallInternal(CallEndReason.TIMEOUT, "Inbound call timed out")
            }
        }
    }

    private fun cancelInboundTimeout() {
        inboundTimeoutJob?.cancel()
        inboundTimeoutJob = null
    }

    private fun cancelTimeout() {
        timeoutJob?.cancel()
        timeoutJob = null
    }

    // ========================================================================
    // Duration timer
    // ========================================================================

    private fun startDurationTimer() {
        stopDurationTimer()
        _elapsedDurationSeconds.value = 0L

        durationJob = scope.launch {
            val connectedTime = _callState.value.activeCallInfo?.connectedTime
                ?: System.currentTimeMillis()

            while (true) {
                val elapsed = (System.currentTimeMillis() - connectedTime) / 1000
                _elapsedDurationSeconds.value = elapsed
                delay(DURATION_UPDATE_INTERVAL_MS)
            }
        }
    }

    private fun stopDurationTimer() {
        durationJob?.cancel()
        durationJob = null
    }

    // ========================================================================
    // Network monitoring
    // ========================================================================

    private fun startNetworkMonitoring() {
        stopNetworkMonitoring()
        networkMonitorJob = scope.launch {
            networkMonitor.isNetworkAvailable.collect { isConnected ->
                val currentState = _callState.value
                if (!isConnected && (currentState.status == CallStatus.CONNECTED ||
                            currentState.status == CallStatus.DIALING)
                ) {
                    Log.w(TAG, "Connectivity lost during active call")
                    try {
                        webRtcAudioClient.disconnect()
                    } catch (e: Exception) {
                        Log.e(TAG, "Error disconnecting WebRTC on connectivity loss", e)
                    }
                    endCallInternal(
                        CallEndReason.CONNECTIVITY_LOST,
                        "Call disconnected due to connectivity loss"
                    )
                }
            }
        }
    }

    private fun stopNetworkMonitoring() {
        networkMonitorJob?.cancel()
        networkMonitorJob = null
    }

    // ========================================================================
    // Ringback tone
    // ========================================================================

    /**
     * Plays a local ringback tone to the user during outbound call setup.
     * The MediaBridge generates server-side ringback, but this local tone provides
     * immediate feedback while the WebRTC connection is still being established.
     * Uses TONE_SUP_RINGTONE which produces a standard telephony ringback cadence.
     */
    private fun startRingbackTone() {
        stopRingbackTone()
        try {
            ringbackToneGenerator = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create ToneGenerator for ringback", e)
            return
        }

        ringbackJob = scope.launch(Dispatchers.Default) {
            try {
                while (true) {
                    ringbackToneGenerator?.startTone(ToneGenerator.TONE_SUP_RINGTONE, 2000)
                    delay(4000)
                }
            } catch (_: kotlinx.coroutines.CancellationException) {
                // Normal cancellation when call connects or ends
            }
        }
    }

    private fun stopRingbackTone() {
        ringbackJob?.cancel()
        ringbackJob = null
        try {
            ringbackToneGenerator?.stopTone()
            ringbackToneGenerator?.release()
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing ringback ToneGenerator", e)
        }
        ringbackToneGenerator = null
    }

    /**
     * Plays a gentle disconnect tone (two short beeps) to indicate the call
     * has ended, similar to Signal's call-ended sound. Audible through the
     * earpiece so the user knows the call is over while holding the phone to ear.
     */
    private fun playDisconnectTone() {
        scope.launch(Dispatchers.Default) {
            try {
                val toneGen = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 50)
                toneGen.startTone(ToneGenerator.TONE_PROP_BEEP2, 200)
                delay(300)
                toneGen.startTone(ToneGenerator.TONE_PROP_BEEP2, 200)
                delay(300)
                toneGen.release()
            } catch (e: Exception) {
                Log.e(TAG, "Error playing disconnect tone", e)
            }
        }
    }

    // ========================================================================
    // WebRTC call initiation
    // ========================================================================

    /**
     * Initiates an outbound call via REST API + WebRTC signaling.
     *
     * Flow: POST /calls/make → get callId → createOffer() → POST /calls/webrtc/offer → setRemoteAnswer(sdpAnswer)
     *
     * Requirements: 1.2, 1.3
     */
    private suspend fun initiateOutboundCall(from: String, to: String) {
        // Step 1: Tell the server to initiate the call
        Log.d(TAG, "Initiating outbound call via REST API from=$from to=$to")
        val response = callsApi.makeCall(from, to)

        // Step 2: Update call state with real callId from server
        _callState.value = _callState.value.copy(
            activeCallInfo = _callState.value.activeCallInfo?.copy(
                callId = response.callId
            )
        )
        Log.d(TAG, "Outbound call initiated, callId=${response.callId}")

        // Step 3: Create WebRTC offer and submit to server
        val sdpOffer = webRtcAudioClient.createOffer()
        Log.d(TAG, "Created SDP offer for call ${response.callId}")

        val offerResponse = callsApi.submitWebRtcOffer(response.callId, sdpOffer)
        Log.d(TAG, "Received SDP answer for call ${response.callId}")

        // Step 4: Set remote answer to establish WebRTC connection
        webRtcAudioClient.setRemoteAnswer(offerResponse.sdpAnswer)

        // Step 4b: Add ICE candidates from the server (MediaBridge uses ICE Lite)
        for (candidateDto in offerResponse.iceCandidates) {
            val iceCandidate = IceCandidate(
                candidateDto.sdpMid ?: "0",
                candidateDto.sdpMLineIndex,
                candidateDto.candidate
            )
            webRtcAudioClient.addIceCandidate(iceCandidate)
        }

        // Step 5: Start audio routing
        audioRouter.startCallAudioRouting(telecomManaged = callServiceController.isTelecomPathActive)

        // Step 6: Play local ringback tone while waiting for remote party to answer
        startRingbackTone()
    }

    // ========================================================================
    // Utility
    // ========================================================================

    /**
     * Normalizes a phone number to E.164 format using the provider number's country code.
     *
     * Handles:
     * - Already E.164 (starts with "+"): returned as-is
     * - Leading "0" (international local format, e.g., UK 07xxx): stripped and country code prepended
     * - Bare digits matching national number length for the country code (e.g., US 10-digit):
     *   country code prepended
     *
     * @param to The destination number as entered by the user
     * @param from The provider/caller number in E.164 format (used to infer country code)
     * @return The number in E.164 format, or the original if normalization isn't possible
     */
    internal fun normalizeToE164(to: String, from: String): String {
        val trimmed = to.trim()
        if (trimmed.startsWith("+")) return trimmed
        if (!from.startsWith("+") || from.length < 3) return trimmed

        // Extract country code from the from/provider number
        val fromDigits = from.drop(1) // Remove leading +
        val countryCode = when {
            fromDigits[0] == '1' || fromDigits[0] == '7' -> fromDigits.take(1)
            else -> {
                val twoDigit = fromDigits.take(2)
                val twoDigitCodes = setOf(
                    "20","27","30","31","32","33","34","36","39",
                    "40","41","43","44","45","46","47","48","49",
                    "51","52","53","54","55","56","57","58",
                    "60","61","62","63","64","65","66",
                    "81","82","84","86","90","91","92","93","94","95","98"
                )
                if (twoDigitCodes.contains(twoDigit)) twoDigit else fromDigits.take(3)
            }
        }

        // Leading 0 → strip and prepend country code (e.g., 07xxx → +447xxx)
        if (trimmed.startsWith("0") && trimmed.length > 1) {
            return "+$countryCode${trimmed.drop(1)}"
        }

        // Bare digits without leading 0 — check if it's a plausible national number.
        // For NANP (country code "1"), national numbers are exactly 10 digits.
        // For most other countries, national numbers are typically 7-12 digits.
        val digitsOnly = trimmed.filter { it.isDigit() }
        val isPlausibleNationalNumber = when (countryCode) {
            "1" -> digitsOnly.length == 10
            "7" -> digitsOnly.length == 10
            "44" -> digitsOnly.length in 9..10
            "61" -> digitsOnly.length == 9
            "33" -> digitsOnly.length == 9
            "49" -> digitsOnly.length in 10..11
            "46" -> digitsOnly.length in 7..9
            else -> digitsOnly.length in 7..12
        }

        return if (isPlausibleNationalNumber) {
            "+$countryCode$digitsOnly"
        } else {
            trimmed
        }
    }

    private fun getDeviceId(): String {
        return authManager.getDeviceId() ?: "unknown-device"
    }
}
