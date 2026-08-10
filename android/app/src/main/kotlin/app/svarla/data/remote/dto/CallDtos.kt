package app.svarla.data.remote.dto

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNames

@Serializable
data class CallHistoryDto(
    val id: String,
    val phoneNumber: String,
    val providerNumber: String? = null,
    val providerNumberLabel: String? = null,
    val callType: String,
    val timestamp: String,
    val durationSeconds: Int? = null,
    val answeredByDevice: String? = null,
    val realCallerNumber: String? = null
)

@Serializable
data class CallHistoryListResponse(
    val entries: List<CallHistoryDto> = emptyList(),
    val page: Int = 1,
    val pageSize: Int = 50,
    val total: Int = 0,
    val totalPages: Int = 0
)

@Serializable
data class AnswerCallRequest(
    @SerialName("device_id") val deviceId: String
)

@Serializable
data class AnswerCallResponse(
    val success: Boolean = false,
    @SerialName("client_token") val clientToken: String? = null,
    @SerialName("clientToken") val clientTokenCamel: String? = null,
    @SerialName("error_reason") val errorReason: String? = null,
    val error: String? = null
)

@Serializable
data class DeclineCallResponse(
    val success: Boolean
)

@Serializable
data class MakeCallRequest(
    val from: String,
    val to: String
)

@Serializable
data class MakeCallResponse(
    val callId: String,
    val clientToken: String? = null,
    val to: String,
    val from: String
)

@Serializable
data class WebRtcOfferRequest(
    val sdpOffer: String,
    val callId: String
)

@Serializable
data class WebRtcOfferResponse(
    val sdpAnswer: String,
    val iceCandidates: List<IceCandidateDto> = emptyList()
)

@Serializable
data class IceCandidateDto(
    val candidate: String,
    val sdpMid: String? = null,
    val sdpMLineIndex: Int = 0
)

@Serializable
data class DtmfRequest(
    val digit: String
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class ActiveCallDto(
    val callId: String,
    val status: String,
    val from: String? = null,
    @JsonNames("vonageNumber")
    @SerialName("providerNumber") val providerNumber: String? = null,
    @JsonNames("vonageNumberLabel")
    @SerialName("providerNumberLabel") val providerNumberLabel: String? = null,
    val startedAt: Long? = null
)

@Serializable
data class ActiveCallsResponse(
    val calls: List<ActiveCallDto> = emptyList()
)
