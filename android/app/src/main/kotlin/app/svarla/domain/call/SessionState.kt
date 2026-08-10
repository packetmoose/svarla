package app.svarla.domain.call

/**
 * Represents the state of the voice session.
 *
 * State transitions:
 * - Disconnected → Connecting (WebRTC connection initiated)
 * - Connecting → Connected (session established successfully)
 * - Connecting → Error (authentication or network failure)
 * - Connected → Error (connection lost)
 * - Connected → Disconnected (disconnect called)
 * - Error → Disconnected (disconnect called or reset)
 */
sealed class SessionState {
    /** No active session. Initial state and state after destroy(). */
    object Disconnected : SessionState()

    /** Session initialization in progress. Waiting for WebRTC connection. */
    object Connecting : SessionState()

    /** Session established and ready for call operations. */
    data class Connected(val user: String) : SessionState()

    /** Session failed due to authentication, network, or timeout error. */
    data class Error(val message: String) : SessionState()
}
