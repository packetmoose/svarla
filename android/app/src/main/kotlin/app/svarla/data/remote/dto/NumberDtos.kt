package app.svarla.data.remote.dto

import kotlinx.serialization.Serializable

@Serializable
data class ProviderNumberDto(
    val number: String,
    val label: String? = null,
    val color: String = "#6750A4",
    val isActive: Boolean = true,
    val lastUsedAt: String? = null,
    val blockInboundCalls: Boolean = false
)

@Serializable
data class NumberListResponse(
    val numbers: List<ProviderNumberDto>,
    val defaultNumber: String? = null
)

@Serializable
data class UpdateLabelRequest(
    val label: String
)

@Serializable
data class UpdateLabelResponse(
    val number: String,
    val label: String
)

@Serializable
data class UpdateBlockInboundRequest(
    val block: Boolean
)

@Serializable
data class UpdateBlockInboundResponse(
    val number: String,
    val blockInboundCalls: Boolean
)

@Serializable
data class SetDefaultNumberRequest(
    val number: String?
)

@Serializable
data class SetDefaultNumberResponse(
    val message: String,
    val defaultNumber: String? = null
)
