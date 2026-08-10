package app.svarla.domain.call

import kotlinx.coroutines.flow.StateFlow
import org.webrtc.IceCandidate

/**
 * Provider-agnostic WebRTC audio client interface.
 *
 * Manages a single WebRTC peer connection to the MediaBridge for voice audio.
 * Replaces all provider-specific SDK clients with a unified
 * WebRTC-based audio transport.
 *
 * Requirements: 1.2, 2.1, 2.5, 2.8
 */
interface WebRtcAudioClient {

    /** Current WebRTC connection state. */
    val connectionState: StateFlow<WebRtcState>

    /**
     * Create an SDP offer for a new audio session.
     *
     * Initializes the PeerConnection (if not already created), adds a local
     * audio track, and generates an SDP offer string for the MediaBridge.
     *
     * @return The SDP offer string to send to the server
     */
    suspend fun createOffer(): String

    /**
     * Set the remote SDP answer received from the MediaBridge via the server.
     *
     * @param sdpAnswer The SDP answer string from the server
     */
    suspend fun setRemoteAnswer(sdpAnswer: String)

    /**
     * Add a remote ICE candidate received from the server.
     *
     * @param candidate The ICE candidate from the MediaBridge
     */
    fun addIceCandidate(candidate: IceCandidate)

    /**
     * Set the mute state for the local audio track.
     *
     * @param muted true to disable (mute) the local audio track, false to enable
     */
    fun setMuted(muted: Boolean)

    /**
     * Send a DTMF digit via RTP telephone-event (RFC 2833).
     *
     * @param digit The DTMF character to send (0-9, *, #)
     */
    fun sendDtmf(digit: Char)

    /**
     * Close the peer connection and release all WebRTC resources.
     *
     * Transitions connectionState to Disconnected.
     */
    fun disconnect()
}

/**
 * Represents the state of the WebRTC connection to the MediaBridge.
 *
 * State transitions:
 * - Disconnected → Connecting (createOffer called)
 * - Connecting → Connected (ICE connected, DTLS complete)
 * - Connecting → Failed (ICE failed or timeout)
 * - Connected → Disconnected (disconnect called or remote close)
 * - Connected → Failed (connectivity lost)
 * - Failed → Disconnected (disconnect called)
 */
sealed class WebRtcState {
    /** No active peer connection. Initial state and state after disconnect(). */
    data object Disconnected : WebRtcState()

    /** Peer connection created, ICE/DTLS negotiation in progress. */
    data object Connecting : WebRtcState()

    /** Peer connection established, audio flowing. */
    data object Connected : WebRtcState()

    /** Connection failed due to ICE failure or connectivity loss. */
    data class Failed(val reason: String) : WebRtcState()
}
