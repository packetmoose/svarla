package app.svarla.domain.call

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe

/**
 * Unit tests for the CallState data model and state transitions logic.
 * Validates the call state machine integrity without requiring Android dependencies.
 */
class CallStateTest : FunSpec({

    test("default CallState should be IDLE with no active call") {
        val state = CallState()

        state.status shouldBe CallStatus.IDLE
        state.activeCallInfo shouldBe null
        state.endReason shouldBe null
        state.errorMessage shouldBe null
    }

    test("DIALING state should have active call info for outbound call") {
        val callInfo = ActiveCallInfo(
            callId = "",
            remoteNumber = "+14155555678",
            providerNumber = "+14155551234",
            startTime = System.currentTimeMillis(),
            isInbound = false
        )
        val state = CallState(status = CallStatus.DIALING, activeCallInfo = callInfo)

        state.status shouldBe CallStatus.DIALING
        state.activeCallInfo shouldNotBe null
        state.activeCallInfo?.remoteNumber shouldBe "+14155555678"
        state.activeCallInfo?.providerNumber shouldBe "+14155551234"
        state.activeCallInfo?.isInbound shouldBe false
        state.activeCallInfo?.connectedTime shouldBe null
    }

    test("RINGING state should have active call info for inbound call") {
        val callInfo = ActiveCallInfo(
            callId = "call-abc-123",
            remoteNumber = "+14155559999",
            providerNumber = "+14155551234",
            providerNumberLabel = "Personal",
            startTime = 1700000000000L,
            isInbound = true
        )
        val state = CallState(status = CallStatus.RINGING, activeCallInfo = callInfo)

        state.status shouldBe CallStatus.RINGING
        state.activeCallInfo?.callId shouldBe "call-abc-123"
        state.activeCallInfo?.remoteNumber shouldBe "+14155559999"
        state.activeCallInfo?.providerNumberLabel shouldBe "Personal"
        state.activeCallInfo?.isInbound shouldBe true
    }

    test("CONNECTED state should have connectedTime set") {
        val now = System.currentTimeMillis()
        val callInfo = ActiveCallInfo(
            callId = "call-abc-123",
            remoteNumber = "+14155559999",
            providerNumber = "+14155551234",
            startTime = now - 5000,
            connectedTime = now,
            isInbound = true
        )
        val state = CallState(status = CallStatus.CONNECTED, activeCallInfo = callInfo)

        state.status shouldBe CallStatus.CONNECTED
        state.activeCallInfo?.connectedTime shouldNotBe null
        state.activeCallInfo?.connectedTime shouldBe now
    }

    test("ENDED state should have end reason set") {
        val callInfo = ActiveCallInfo(
            callId = "call-abc-123",
            remoteNumber = "+14155559999",
            providerNumber = "+14155551234",
            startTime = 1700000000000L,
            connectedTime = 1700000005000L,
            isInbound = false
        )
        val state = CallState(
            status = CallStatus.ENDED,
            activeCallInfo = callInfo,
            endReason = CallEndReason.LOCAL_HANGUP
        )

        state.status shouldBe CallStatus.ENDED
        state.endReason shouldBe CallEndReason.LOCAL_HANGUP
        state.errorMessage shouldBe null
    }

    test("ENDED state with CONNECTIVITY_LOST should have error message") {
        val callInfo = ActiveCallInfo(
            callId = "call-abc-123",
            remoteNumber = "+14155559999",
            providerNumber = "+14155551234",
            startTime = 1700000000000L,
            isInbound = false
        )
        val state = CallState(
            status = CallStatus.ENDED,
            activeCallInfo = callInfo,
            endReason = CallEndReason.CONNECTIVITY_LOST,
            errorMessage = "Call disconnected due to connectivity loss"
        )

        state.status shouldBe CallStatus.ENDED
        state.endReason shouldBe CallEndReason.CONNECTIVITY_LOST
        state.errorMessage shouldBe "Call disconnected due to connectivity loss"
    }

    test("ENDED state with UNANSWERED should indicate timeout") {
        val callInfo = ActiveCallInfo(
            callId = "",
            remoteNumber = "+14155555678",
            providerNumber = "+14155551234",
            startTime = 1700000000000L,
            isInbound = false
        )
        val state = CallState(
            status = CallStatus.ENDED,
            activeCallInfo = callInfo,
            endReason = CallEndReason.UNANSWERED,
            errorMessage = "Call not answered"
        )

        state.status shouldBe CallStatus.ENDED
        state.endReason shouldBe CallEndReason.UNANSWERED
    }

    test("ENDED state with ANSWERED_ELSEWHERE for multi-device handling") {
        val callInfo = ActiveCallInfo(
            callId = "call-123",
            remoteNumber = "+14155559999",
            providerNumber = "+14155551234",
            providerNumberLabel = "Business",
            startTime = 1700000000000L,
            isInbound = true
        )
        val state = CallState(
            status = CallStatus.ENDED,
            activeCallInfo = callInfo,
            endReason = CallEndReason.ANSWERED_ELSEWHERE
        )

        state.status shouldBe CallStatus.ENDED
        state.endReason shouldBe CallEndReason.ANSWERED_ELSEWHERE
    }

    test("ActiveCallInfo without label should default to null") {
        val callInfo = ActiveCallInfo(
            callId = "call-123",
            remoteNumber = "+14155559999",
            providerNumber = "+14155551234",
            startTime = 1700000000000L,
            isInbound = true
        )

        callInfo.providerNumberLabel shouldBe null
    }

    test("all CallEndReason values are distinct") {
        val reasons = CallEndReason.entries
        reasons.size shouldBe 8
        reasons.distinct().size shouldBe reasons.size
    }

    test("all CallStatus values represent valid state machine states") {
        val statuses = CallStatus.entries
        statuses.size shouldBe 5
        statuses shouldBe listOf(
            CallStatus.IDLE,
            CallStatus.DIALING,
            CallStatus.RINGING,
            CallStatus.CONNECTED,
            CallStatus.ENDED
        )
    }
})
