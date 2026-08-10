package app.svarla.domain.call

import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.DisconnectCause
import kotlinx.coroutines.launch

/**
 * Per-call Connection subclass with bidirectional state sync between the
 * Android Telecom framework and [VoiceCallManager].
 *
 * Framework-initiated events (onAnswer, onReject, onDisconnect) propagate to
 * VoiceCallManager. VoiceCallManager state changes (CONNECTED, ENDED) propagate
 * back via [onCallConnected] and [onCallEnded] to update the Connection state.
 *
 * Uses PROPERTY_SELF_MANAGED exclusively — the app owns the call UI at all times.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 10.2, 10.4
 */
class SvarlaConnection(
    private val voiceCallManager: VoiceCallManager,
    private val callId: String
) : Connection() {

    private var observerJob: kotlinx.coroutines.Job? = null

    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        // Do NOT add CAPABILITY_HOLD, CAPABILITY_SUPPORT_HOLD, etc.
        // Self-managed connections own all UI.
    }

    /**
     * Start observing VoiceCallManager state for defensive cleanup.
     * If the call transitions to ENDED or IDLE while this connection is still alive,
     * we auto-disconnect. This prevents orphaned connections that block other apps
     * from making calls.
     *
     * Must be called after the connection is created and registered.
     */
    fun observeCallState(scope: kotlinx.coroutines.CoroutineScope) {
        observerJob = scope.launch {
            voiceCallManager.callState.collect { state ->
                if (state.status == CallStatus.ENDED || state.status == CallStatus.IDLE) {
                    // If this connection hasn't been disconnected yet, do it now
                    if (getState() != STATE_DISCONNECTED) {
                        val cause = if (state.endReason != null) {
                            CallServiceControllerImpl.toDisconnectCause(state.endReason)
                        } else {
                            DisconnectCause(DisconnectCause.MISSED)
                        }
                        setDisconnected(cause)
                        destroy()
                    }
                }
            }
        }
    }

    // ====== Framework → App (user actions via system UI, if any) ======

    /**
     * Called by the Telecom framework when the user answers the call.
     * Transitions this connection to STATE_ACTIVE and notifies VoiceCallManager.
     *
     * Requirements: 3.3, 9.4
     */
    @Suppress("DEPRECATION")
    @Deprecated("Deprecated in Java")
    override fun onAnswer() {
        setActive()
        voiceCallManager.answerCall(callId)
    }

    /**
     * Called by the Telecom framework when the user rejects the call.
     * Transitions this connection to STATE_DISCONNECTED with REJECTED cause,
     * notifies VoiceCallManager to decline, and destroys the connection.
     *
     * Requirements: 3.4, 9.5
     */
    override fun onReject() {
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        voiceCallManager.declineCall(callId)
        observerJob?.cancel()
        destroy()
    }

    /**
     * Called by the Telecom framework when the call is disconnected (e.g., user hangs up).
     * Transitions this connection to STATE_DISCONNECTED with LOCAL cause,
     * notifies VoiceCallManager to end the call, and destroys the connection.
     *
     * Requirements: 3.5, 9.3
     */
    override fun onDisconnect() {
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        voiceCallManager.endCall()
        observerJob?.cancel()
        destroy()
    }

    /**
     * Called by the Telecom framework when the call audio state changes.
     * Audio focus is managed by the Telecom framework in self-managed mode.
     * Speaker/mute control is handled by AudioRouter directly.
     */
    @Suppress("DEPRECATION")
    @Deprecated("Deprecated in Java")
    override fun onCallAudioStateChanged(state: CallAudioState?) {
        // Audio focus managed by Telecom framework.
        // Speaker/mute handled by AudioRouter directly.
    }

    // ====== App → Framework (VoiceCallManager state changes) ======

    /**
     * Called when VoiceCallManager transitions to CONNECTED state.
     * Updates the Telecom framework by transitioning this connection to STATE_ACTIVE.
     *
     * Requirements: 3.7, 9.1
     */
    fun onCallConnected() {
        setActive()
    }

    /**
     * Called when VoiceCallManager transitions to ENDED state.
     * Updates the Telecom framework by transitioning this connection to STATE_DISCONNECTED
     * with the appropriate cause, then destroys the connection.
     *
     * Requirements: 3.5, 9.2
     */
    fun onCallEnded(cause: DisconnectCause) {
        setDisconnected(cause)
        observerJob?.cancel()
        destroy()
    }
}
