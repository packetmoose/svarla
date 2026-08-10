package app.svarla.data.remote.api

import app.svarla.data.remote.dto.ActiveCallsResponse
import app.svarla.data.remote.dto.AnswerCallRequest
import app.svarla.data.remote.dto.AnswerCallResponse
import app.svarla.data.remote.dto.CallHistoryListResponse
import app.svarla.data.remote.dto.DeclineCallResponse
import app.svarla.data.remote.dto.MakeCallRequest
import app.svarla.data.remote.dto.MakeCallResponse
import app.svarla.data.remote.dto.WebRtcOfferResponse

/**
 * API service for voice call endpoints.
 */
interface CallsApi {

    /**
     * GET /api/calls/active — Get currently active calls (for late-joining devices).
     */
    suspend fun getActiveCalls(): ActiveCallsResponse

    /**
     * GET /api/calls/history — Get call history (paginated, max 1000).
     */
    suspend fun getCallHistory(page: Int = 1, pageSize: Int = 50): CallHistoryListResponse

    /**
     * POST /api/calls/make — Initiate an outbound call.
     */
    suspend fun makeCall(from: String, to: String): MakeCallResponse

    /**
     * POST /api/calls/answer/{callId} — Signal that this device is answering the call.
     */
    suspend fun answerCall(callId: String, request: AnswerCallRequest): AnswerCallResponse

    /**
     * POST /api/calls/decline/{callId} — Signal that this device is declining the call.
     */
    suspend fun declineCall(callId: String): DeclineCallResponse

    /**
     * POST /api/calls/webrtc/offer — Submit an SDP offer for WebRTC audio session negotiation.
     */
    suspend fun submitWebRtcOffer(callId: String, sdpOffer: String): WebRtcOfferResponse

    /**
     * POST /api/calls/{callId}/dtmf — Send a DTMF digit via the out-of-band REST fallback.
     */
    suspend fun sendDtmf(callId: String, digit: Char)
}
