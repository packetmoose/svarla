package app.svarla.domain.call

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

/**
 * Unit tests for [CallTeardownDecider] — the pure teardown decision logic that
 * governs how remote-hangup / call-cancelled signals end an active call.
 *
 * These cover the bug where a caller hangup left the call active on-device:
 * a "disconnected" event whose callId didn't match the (un-enriched) local id
 * was silently dropped. The decider now honors such events while CONNECTED.
 */
class CallTeardownDeciderTest : FunSpec({

    context("mapCancelReason") {
        test("maps answered_elsewhere") {
            CallTeardownDecider.mapCancelReason("answered_elsewhere") shouldBe
                CallEndReason.ANSWERED_ELSEWHERE
        }

        test("maps declined") {
            CallTeardownDecider.mapCancelReason("declined") shouldBe CallEndReason.DECLINED
        }

        test("maps canonical caller_disconnect to remote hangup") {
            CallTeardownDecider.mapCancelReason("caller_disconnect") shouldBe
                CallEndReason.REMOTE_HANGUP
        }

        test("maps timeout") {
            CallTeardownDecider.mapCancelReason("timeout") shouldBe CallEndReason.TIMEOUT
        }

        test("maps null to remote hangup") {
            CallTeardownDecider.mapCancelReason(null) shouldBe CallEndReason.REMOTE_HANGUP
        }

        test("maps unknown/legacy spellings to remote hangup") {
            // Guards against the historical caller_disconnect vs caller_disconnected mismatch.
            CallTeardownDecider.mapCancelReason("caller_disconnected") shouldBe
                CallEndReason.REMOTE_HANGUP
            CallTeardownDecider.mapCancelReason("something_else") shouldBe
                CallEndReason.REMOTE_HANGUP
        }
    }

    context("shouldEndOnNonMatchingCallId") {
        test("ends a CONNECTED call on a non-matching strict disconnect (the bug fix)") {
            // This is the core regression: caller hangs up, server broadcasts the
            // internal callId, local id is still the notification id → must still end.
            CallTeardownDecider.shouldEndOnNonMatchingCallId(CallStatus.CONNECTED, strict = true) shouldBe true
        }

        test("ends a CONNECTED call on a non-matching completed event") {
            CallTeardownDecider.shouldEndOnNonMatchingCallId(CallStatus.CONNECTED, strict = false) shouldBe true
        }

        test("ends a DIALING call on a non-matching event regardless of strictness") {
            CallTeardownDecider.shouldEndOnNonMatchingCallId(CallStatus.DIALING, strict = true) shouldBe true
            CallTeardownDecider.shouldEndOnNonMatchingCallId(CallStatus.DIALING, strict = false) shouldBe true
        }

        test("does NOT end a RINGING call on a non-matching strict disconnect") {
            // A stray internal leg event should not kill a call that's still ringing.
            CallTeardownDecider.shouldEndOnNonMatchingCallId(CallStatus.RINGING, strict = true) shouldBe false
        }

        test("ends a RINGING call on a non-matching completed event") {
            CallTeardownDecider.shouldEndOnNonMatchingCallId(CallStatus.RINGING, strict = false) shouldBe true
        }

        test("never acts while IDLE or ENDED") {
            CallTeardownDecider.shouldEndOnNonMatchingCallId(CallStatus.IDLE, strict = true) shouldBe false
            CallTeardownDecider.shouldEndOnNonMatchingCallId(CallStatus.IDLE, strict = false) shouldBe false
            CallTeardownDecider.shouldEndOnNonMatchingCallId(CallStatus.ENDED, strict = true) shouldBe false
            CallTeardownDecider.shouldEndOnNonMatchingCallId(CallStatus.ENDED, strict = false) shouldBe false
        }
    }
})
