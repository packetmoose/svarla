package app.svarla.domain.call

import android.content.Context
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * WebRTC audio client implementation using the GMS-free libwebrtc SDK.
 *
 * Manages a single PeerConnection to the MediaBridge for bidirectional
 * Opus audio transport. Audio-only (no video tracks). Uses standard WebRTC
 * echo cancellation, jitter buffering, and noise suppression (no custom DSP).
 *
 * The PeerConnection is configured with ICE servers pointing to the MediaBridge's
 * fixed TCP port and public IP address. No STUN/TURN infrastructure is required.
 *
 * Requirements: 1.2, 2.1, 2.5, 2.8
 */
@Singleton
class WebRtcAudioClientImpl @Inject constructor(
    @ApplicationContext private val appContext: Context
) : WebRtcAudioClient {

    companion object {
        private const val TAG = "WebRtcAudioClient"
        private const val LOCAL_AUDIO_TRACK_ID = "svarla-audio-track"
        private const val LOCAL_STREAM_ID = "svarla-audio-stream"
    }

    private val _connectionState = MutableStateFlow<WebRtcState>(WebRtcState.Disconnected)
    override val connectionState: StateFlow<WebRtcState> = _connectionState.asStateFlow()

    private val _mediaReceiving = MutableStateFlow(true)
    override val mediaReceiving: StateFlow<Boolean> = _mediaReceiving.asStateFlow()

    private var peerConnectionFactory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var localAudioTrack: AudioTrack? = null
    private var audioSource: AudioSource? = null

    // ========================================================================
    // Public API
    // ========================================================================

    override suspend fun createOffer(): String {
        Log.d(TAG, "Creating SDP offer")
        _connectionState.value = WebRtcState.Connecting

        ensureFactory()
        createPeerConnection()
        addLocalAudioTrack()

        return generateOffer()
    }

    override suspend fun setRemoteAnswer(sdpAnswer: String) {
        val pc = peerConnection
            ?: throw IllegalStateException("PeerConnection not initialized. Call createOffer() first.")

        Log.d(TAG, "Setting remote SDP answer")

        val sessionDescription = SessionDescription(
            SessionDescription.Type.ANSWER,
            sdpAnswer
        )

        suspendCancellableCoroutine { continuation ->
            pc.setRemoteDescription(object : SdpObserver {
                override fun onSetSuccess() {
                    Log.d(TAG, "Remote answer set successfully")
                    continuation.resume(Unit)
                }

                override fun onSetFailure(error: String?) {
                    Log.e(TAG, "Failed to set remote answer: $error")
                    continuation.resumeWithException(
                        RuntimeException("Failed to set remote answer: $error")
                    )
                }

                override fun onCreateSuccess(sdp: SessionDescription?) {}
                override fun onCreateFailure(error: String?) {}
            }, sessionDescription)
        }
    }

    override fun addIceCandidate(candidate: IceCandidate) {
        val pc = peerConnection
        if (pc == null) {
            Log.w(TAG, "addIceCandidate called but PeerConnection is null")
            return
        }

        Log.d(TAG, "Adding ICE candidate: ${candidate.sdpMid}:${candidate.sdpMLineIndex}")
        pc.addIceCandidate(candidate)
    }

    override fun setMuted(muted: Boolean) {
        val track = localAudioTrack
        if (track == null) {
            Log.w(TAG, "setMuted called but no local audio track exists")
            return
        }

        Log.d(TAG, "Setting muted=$muted")
        track.setEnabled(!muted)
    }

    override fun sendDtmf(digit: Char) {
        val pc = peerConnection
        if (pc == null) {
            Log.w(TAG, "sendDtmf called but PeerConnection is null")
            return
        }

        val senders = pc.senders
        val audioSender = senders.firstOrNull { sender ->
            sender.track()?.kind() == "audio"
        }

        if (audioSender == null) {
            Log.w(TAG, "sendDtmf: no audio sender found")
            return
        }

        val dtmfSender = audioSender.dtmf()
        if (dtmfSender == null) {
            Log.w(TAG, "sendDtmf: DTMFSender not available on audio sender")
            return
        }

        Log.d(TAG, "Sending DTMF digit=$digit")
        // Duration 100ms, inter-tone gap 70ms (standard telephony values)
        dtmfSender.insertDtmf(digit.toString(), 100, 70)
    }

    override fun disconnect() {
        Log.d(TAG, "Disconnecting WebRTC session")

        localAudioTrack?.setEnabled(false)
        localAudioTrack?.dispose()
        localAudioTrack = null

        audioSource?.dispose()
        audioSource = null

        peerConnection?.close()
        peerConnection?.dispose()
        peerConnection = null

        _connectionState.value = WebRtcState.Disconnected
        // Reset for the next call so the media-inactivity watchdog doesn't see a
        // stale "not receiving" carried over from the previous session.
        _mediaReceiving.value = true
    }

    // ========================================================================
    // Private: Factory initialization
    // ========================================================================

    /**
     * Ensure the PeerConnectionFactory is initialized. Audio-only configuration
     * with standard WebRTC echo cancellation, noise suppression, and jitter
     * buffering enabled via the default audio device module.
     */
    private fun ensureFactory() {
        if (peerConnectionFactory != null) return

        Log.d(TAG, "Initializing PeerConnectionFactory (audio-only)")

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )

        val audioDeviceModule = JavaAudioDeviceModule.builder(appContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()

        peerConnectionFactory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioDeviceModule)
            .setOptions(PeerConnectionFactory.Options())
            .createPeerConnectionFactory()
    }

    // ========================================================================
    // Private: PeerConnection setup
    // ========================================================================

    /**
     * Create a new PeerConnection with ICE configuration pointing to the
     * MediaBridge's fixed TCP port. The MediaBridge uses ICE Lite with a
     * known public IP, so no STUN/TURN servers are needed.
     */
    private fun createPeerConnection() {
        // Close any existing peer connection
        peerConnection?.close()
        peerConnection?.dispose()
        peerConnection = null

        val factory = peerConnectionFactory
            ?: throw IllegalStateException("PeerConnectionFactory not initialized")

        // ICE configuration: MediaBridge advertises its own public IP + fixed TCP port.
        // No STUN/TURN servers are required since the MediaBridge uses ICE Lite.
        val rtcConfig = PeerConnection.RTCConfiguration(emptyList()).apply {
            // TCP is the primary transport for firewall/VPN compatibility
            tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.ENABLED
            // Bundle audio over a single transport
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            // Continuous gathering for faster ICE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            // Audio-only: no need for multiple media streams
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }

        peerConnection = factory.createPeerConnection(rtcConfig, peerConnectionObserver)
            ?: throw RuntimeException("Failed to create PeerConnection")

        Log.d(TAG, "PeerConnection created")
    }

    /**
     * Add a local audio track to the PeerConnection. Configures constraints
     * for echo cancellation, noise suppression, and auto gain control (standard
     * WebRTC audio processing, no custom DSP).
     */
    private fun addLocalAudioTrack() {
        val factory = peerConnectionFactory
            ?: throw IllegalStateException("PeerConnectionFactory not initialized")
        val pc = peerConnection
            ?: throw IllegalStateException("PeerConnection not initialized")

        // Audio constraints: enable standard WebRTC audio processing
        val audioConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "true"))
        }

        audioSource = factory.createAudioSource(audioConstraints)
        localAudioTrack = factory.createAudioTrack(LOCAL_AUDIO_TRACK_ID, audioSource).apply {
            setEnabled(true)
        }

        pc.addTrack(localAudioTrack, listOf(LOCAL_STREAM_ID))

        Log.d(TAG, "Local audio track added to PeerConnection")
    }

    // ========================================================================
    // Private: SDP negotiation
    // ========================================================================

    /**
     * Generate an SDP offer with audio-only constraints.
     * Configures Opus codec for VoIP mode with max 32kbps bitrate.
     */
    private suspend fun generateOffer(): String {
        val pc = peerConnection
            ?: throw IllegalStateException("PeerConnection not initialized")

        // Offer constraints: audio only, no video
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }

        val sdp = suspendCancellableCoroutine { continuation ->
            pc.createOffer(object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription?) {
                    if (sdp != null) {
                        continuation.resume(sdp)
                    } else {
                        continuation.resumeWithException(
                            RuntimeException("createOffer returned null SDP")
                        )
                    }
                }

                override fun onCreateFailure(error: String?) {
                    continuation.resumeWithException(
                        RuntimeException("Failed to create offer: $error")
                    )
                }

                override fun onSetSuccess() {}
                override fun onSetFailure(error: String?) {}
            }, constraints)
        }

        // Modify SDP to constrain Opus codec for VoIP mode and max 32kbps
        val modifiedSdp = applyOpusConstraints(sdp.description)

        val modifiedSessionDescription = SessionDescription(sdp.type, modifiedSdp)

        // Set the local description
        suspendCancellableCoroutine { continuation ->
            pc.setLocalDescription(object : SdpObserver {
                override fun onSetSuccess() {
                    Log.d(TAG, "Local description set successfully")
                    continuation.resume(Unit)
                }

                override fun onSetFailure(error: String?) {
                    Log.e(TAG, "Failed to set local description: $error")
                    continuation.resumeWithException(
                        RuntimeException("Failed to set local description: $error")
                    )
                }

                override fun onCreateSuccess(sdp: SessionDescription?) {}
                override fun onCreateFailure(error: String?) {}
            }, modifiedSessionDescription)
        }

        Log.d(TAG, "SDP offer created and local description set")
        return modifiedSdp
    }

    /**
     * Modify the SDP to configure Opus for VoIP mode with max 32kbps bitrate.
     * Adds fmtp parameters: maxaveragebitrate=32000;usedtx=1;stereo=0;sprop-stereo=0
     */
    private fun applyOpusConstraints(sdp: String): String {
        val lines = sdp.split("\r\n").toMutableList()
        val opusPayloadType = findOpusPayloadType(lines)

        if (opusPayloadType != null) {
            // Find existing fmtp line for Opus or add one
            val fmtpIndex = lines.indexOfFirst {
                it.startsWith("a=fmtp:$opusPayloadType ")
            }

            val opusParams = "maxaveragebitrate=32000;usedtx=1;stereo=0;sprop-stereo=0"

            if (fmtpIndex >= 0) {
                // Append parameters to existing fmtp line
                val existing = lines[fmtpIndex]
                lines[fmtpIndex] = if (existing.contains(";")) {
                    "$existing;$opusParams"
                } else {
                    "$existing $opusParams"
                }
            } else {
                // Add new fmtp line after the rtpmap line
                val rtpmapIndex = lines.indexOfFirst {
                    it.startsWith("a=rtpmap:$opusPayloadType opus/")
                }
                if (rtpmapIndex >= 0) {
                    lines.add(rtpmapIndex + 1, "a=fmtp:$opusPayloadType $opusParams")
                }
            }
        }

        return lines.joinToString("\r\n")
    }

    /**
     * Find the Opus codec payload type from the SDP rtpmap lines.
     */
    private fun findOpusPayloadType(lines: List<String>): String? {
        for (line in lines) {
            if (line.startsWith("a=rtpmap:") && line.contains("opus/48000")) {
                // Extract payload type number: "a=rtpmap:111 opus/48000/2" → "111"
                return line.removePrefix("a=rtpmap:").split(" ").firstOrNull()
            }
        }
        return null
    }

    // ========================================================================
    // Private: PeerConnection observer
    // ========================================================================

    private val peerConnectionObserver = object : PeerConnection.Observer {

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            Log.d(TAG, "ICE connection state: $state")
            when (state) {
                PeerConnection.IceConnectionState.CHECKING ->
                    _connectionState.value = WebRtcState.Connecting

                PeerConnection.IceConnectionState.CONNECTED,
                PeerConnection.IceConnectionState.COMPLETED ->
                    _connectionState.value = WebRtcState.Connected

                PeerConnection.IceConnectionState.FAILED ->
                    _connectionState.value = WebRtcState.Failed("ICE connection failed")

                PeerConnection.IceConnectionState.DISCONNECTED -> {
                    // ICE disconnected can be transient; only mark failed if it doesn't recover
                    Log.w(TAG, "ICE disconnected (may be transient)")
                    _connectionState.value = WebRtcState.Failed("Connection lost")
                }

                PeerConnection.IceConnectionState.CLOSED ->
                    _connectionState.value = WebRtcState.Disconnected

                else -> {}
            }
        }

        override fun onIceConnectionReceivingChange(receiving: Boolean) {
            Log.d(TAG, "ICE receiving: $receiving")
            _mediaReceiving.value = receiving
        }

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
            Log.d(TAG, "ICE gathering state: $state")
        }

        override fun onIceCandidate(candidate: IceCandidate?) {
            if (candidate != null) {
                Log.d(TAG, "Local ICE candidate: ${candidate.sdpMid}:${candidate.sdpMLineIndex}")
                // With ICE Lite on the server side, local candidates are typically
                // included in the initial offer. Trickle ICE candidates can be sent
                // to the server if needed, but ICE Lite handles this via the answer.
            }
        }

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {
            Log.d(TAG, "ICE candidates removed: ${candidates?.size}")
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState?) {
            Log.d(TAG, "Signaling state: $state")
        }

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) {
            Log.d(TAG, "PeerConnection state: $state")
            when (state) {
                PeerConnection.PeerConnectionState.CONNECTING ->
                    _connectionState.value = WebRtcState.Connecting

                PeerConnection.PeerConnectionState.CONNECTED ->
                    _connectionState.value = WebRtcState.Connected

                PeerConnection.PeerConnectionState.FAILED ->
                    _connectionState.value = WebRtcState.Failed("Peer connection failed")

                PeerConnection.PeerConnectionState.DISCONNECTED ->
                    _connectionState.value = WebRtcState.Failed("Connection lost")

                PeerConnection.PeerConnectionState.CLOSED ->
                    _connectionState.value = WebRtcState.Disconnected

                else -> {}
            }
        }

        override fun onAddStream(stream: MediaStream?) {
            Log.d(TAG, "Remote stream added: ${stream?.id}")
        }

        override fun onRemoveStream(stream: MediaStream?) {
            Log.d(TAG, "Remote stream removed: ${stream?.id}")
        }

        override fun onDataChannel(channel: DataChannel?) {
            Log.d(TAG, "Data channel: ${channel?.label()}")
        }

        override fun onRenegotiationNeeded() {
            Log.d(TAG, "Renegotiation needed")
        }

        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
            Log.d(TAG, "Remote track added: ${receiver?.track()?.kind()}")
        }

        override fun onTrack(transceiver: RtpTransceiver?) {
            Log.d(TAG, "onTrack: ${transceiver?.receiver?.track()?.kind()}")
        }
    }
}
