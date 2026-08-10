package app.svarla.data.remote.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class DeviceDto(
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_name") val deviceName: String,
    @SerialName("push_topic_id") val pushTopicId: String,
    @SerialName("registered_at") val registeredAt: String,
    @SerialName("last_seen_at") val lastSeenAt: String,
    @SerialName("is_active") val isActive: Boolean
)

@Serializable
data class DeviceListResponse(
    val devices: List<DeviceDto>
)

@Serializable
data class DeviceRegistrationRequest(
    @SerialName("deviceId") val deviceId: String,
    @SerialName("deviceName") val deviceName: String
)

@Serializable
data class DeviceRegistrationResponse(
    @SerialName("push_topic") val pushTopic: String
)
