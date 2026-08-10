package app.svarla.domain.call

/**
 * Information about an incoming call received via push notification or WebSocket event.
 */
data class IncomingCallInfo(
    /** The unique call identifier */
    val callId: String,
    /** The caller's phone number (E.164 format) */
    val from: String,
    /** The provider number that was called */
    val providerNumber: String,
    /** Timestamp when the incoming call was received (epoch millis) */
    val timestamp: Long
)
