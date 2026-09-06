package app.svarla.domain.call

/**
 * Pure, framework-free decision logic for call teardown.
 *
 * Extracted from [VoiceCallManager] so the tricky "should this termination event
 * end the current call?" and "what reason does this map to?" logic can be unit
 * tested without Android/WebRTC dependencies. Keep this object free of any state
 * or side effects.
 */
object CallTeardownDecider {

    /**
     * Map a server `call_cancelled` reason string to a [CallEndReason].
     *
     * Unknown/absent reasons default to [CallEndReason.REMOTE_HANGUP] since a
     * cancellation that reaches an active call almost always means the far end
     * went away. The canonical caller-hangup spelling is `caller_disconnect`
     * (see the provider-generic-voice spec and the server broadcasters).
     */
    fun mapCancelReason(reason: String?): CallEndReason = when (reason) {
        "answered_elsewhere" -> CallEndReason.ANSWERED_ELSEWHERE
        "declined" -> CallEndReason.DECLINED
        "caller_disconnect" -> CallEndReason.REMOTE_HANGUP
        "timeout" -> CallEndReason.TIMEOUT
        else -> CallEndReason.REMOTE_HANGUP
    }

    /**
     * Decide whether a termination event (`disconnected`/`completed`) whose callId
     * does NOT match the active call should still end the call.
     *
     * Background: inbound calls initially ring using a notification/temp id that is
     * later enriched into the server's internal callId. If that enrichment is lost
     * or races, a server "disconnected" broadcast carrying the internal id won't
     * match the locally-held id. Silently dropping it (the old behavior) left the
     * call active forever after the caller hung up.
     *
     * Rules:
     *  - Never act while [status] is IDLE or ENDED (handled by the caller, but we
     *    also guard here for safety): return false.
     *  - When CONNECTED or DIALING there is only ever one active call on the device,
     *    so a termination signal is safe to honor regardless of id: return true.
     *  - When RINGING, only honor a non-strict ("completed") event — a strict
     *    ("disconnected") event that doesn't match is more likely a stray internal
     *    leg event, so leave the ringing call untouched.
     *
     * @param strict true for `disconnected` events (require match by default),
     *   false for `completed` events (full-call completion, safe as a net).
     */
    fun shouldEndOnNonMatchingCallId(status: CallStatus, strict: Boolean): Boolean = when (status) {
        CallStatus.CONNECTED, CallStatus.DIALING -> true
        CallStatus.RINGING -> !strict
        else -> false
    }
}
