package app.svarla.domain.call

/**
 * Represents the possible states in the voice call state machine.
 *
 * State transitions:
 * - IDLE → DIALING (outbound call initiated)
 * - IDLE → RINGING (inbound call received)
 * - DIALING → CONNECTED (outbound call answered by remote)
 * - DIALING → ENDED (timeout, error, or user cancelled)
 * - RINGING → CONNECTED (user answered inbound call)
 * - RINGING → ENDED (user declined, timeout, or caller hung up)
 * - CONNECTED → ENDED (call ended by either party, error, or connectivity loss)
 */
enum class CallStatus {
    IDLE,
    DIALING,
    RINGING,
    CONNECTED,
    ENDED
}

/**
 * Reason a call ended.
 */
enum class CallEndReason {
    /** Normal hangup by local user */
    LOCAL_HANGUP,
    /** Remote party ended the call */
    REMOTE_HANGUP,
    /** Call failed during setup */
    FAILED,
    /** Outbound call not answered within timeout */
    UNANSWERED,
    /** User declined an inbound call */
    DECLINED,
    /** Call was answered on another device */
    ANSWERED_ELSEWHERE,
    /** Network/data connectivity lost */
    CONNECTIVITY_LOST,
    /** Call timed out (30s timeout) */
    TIMEOUT
}

/**
 * Information about the active call.
 */
data class ActiveCallInfo(
    /** The call ID from the backend/provider */
    val callId: String,
    /** The remote party phone number (E.164) */
    val remoteNumber: String,
    /** The provider number used for this call */
    val providerNumber: String,
    /** Label of the provider number (e.g., "Personal") */
    val providerNumberLabel: String? = null,
    /** Hex color assigned to the provider number */
    val providerNumberColor: String? = null,
    /** Timestamp when the call was initiated or received (epoch millis) */
    val startTime: Long,
    /** Timestamp when the call was connected (epoch millis), null if not yet connected */
    val connectedTime: Long? = null,
    /** Whether this is an inbound or outbound call */
    val isInbound: Boolean
)

/**
 * The overall call state exposed to the UI via StateFlow.
 */
data class CallState(
    /** Current status of the call state machine */
    val status: CallStatus = CallStatus.IDLE,
    /** Information about the active call, null when IDLE */
    val activeCallInfo: ActiveCallInfo? = null,
    /** Reason the call ended, only set when status is ENDED */
    val endReason: CallEndReason? = null,
    /** Error message, if any */
    val errorMessage: String? = null
)
