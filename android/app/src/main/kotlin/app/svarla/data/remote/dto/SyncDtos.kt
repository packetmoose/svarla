package app.svarla.data.remote.dto

import kotlinx.serialization.Serializable

@Serializable
data class SyncStateResponse(
    val numbers: List<ProviderNumberDto> = emptyList(),
    val conversations: List<ConversationDto> = emptyList(),
    val callHistory: List<CallHistoryDto> = emptyList(),
    val devices: List<DeviceDto> = emptyList()
)

@Serializable
data class WebSocketEvent(
    val type: String,
    val data: kotlinx.serialization.json.JsonElement? = null
)
