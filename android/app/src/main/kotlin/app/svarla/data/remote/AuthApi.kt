package app.svarla.data.remote

import kotlinx.serialization.Serializable

@Serializable
data class LoginRequest(
    val password: String,
    val deviceName: String,
    val pushTopicId: String
)

@Serializable
data class LoginResponse(
    val sessionToken: String,
    val deviceId: String? = null,
    val pushTopicId: String? = null
)

@Serializable
data class LoginErrorResponse(
    val error: String? = null,
    val lockedUntil: Long? = null
)
