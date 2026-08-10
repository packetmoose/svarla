package app.svarla.data.remote.api

import app.svarla.data.remote.dto.ActiveCallsResponse
import app.svarla.data.remote.dto.AnswerCallRequest
import app.svarla.data.remote.dto.AnswerCallResponse
import app.svarla.data.remote.dto.CallHistoryListResponse
import app.svarla.data.remote.dto.DeclineCallResponse
import app.svarla.data.remote.dto.DtmfRequest
import app.svarla.data.remote.dto.MakeCallRequest
import app.svarla.data.remote.dto.MakeCallResponse
import app.svarla.data.remote.dto.WebRtcOfferRequest
import app.svarla.data.remote.dto.WebRtcOfferResponse
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class CallsApiImpl @Inject constructor(
    private val apiClient: ApiClient
) : CallsApi {

    override suspend fun getActiveCalls(): ActiveCallsResponse {
        return apiClient.get("/api/calls/active")
    }

    override suspend fun getCallHistory(page: Int, pageSize: Int): CallHistoryListResponse {
        return apiClient.get(
            "/api/calls/history",
            mapOf("page" to page, "pageSize" to pageSize)
        )
    }

    override suspend fun makeCall(from: String, to: String): MakeCallResponse {
        return apiClient.post("/api/calls/make", MakeCallRequest(from = from, to = to))
    }

    override suspend fun answerCall(callId: String, request: AnswerCallRequest): AnswerCallResponse {
        return apiClient.post("/api/calls/answer/$callId", request)
    }

    override suspend fun declineCall(callId: String): DeclineCallResponse {
        return apiClient.post("/api/calls/decline/$callId")
    }

    override suspend fun submitWebRtcOffer(callId: String, sdpOffer: String): WebRtcOfferResponse {
        return apiClient.post(
            "/api/calls/webrtc/offer",
            WebRtcOfferRequest(sdpOffer = sdpOffer, callId = callId)
        )
    }

    override suspend fun sendDtmf(callId: String, digit: Char) {
        apiClient.post<Unit>("/api/calls/$callId/dtmf", DtmfRequest(digit = digit.toString()))
    }
}
