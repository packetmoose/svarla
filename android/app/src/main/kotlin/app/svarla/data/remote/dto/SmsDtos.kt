package app.svarla.data.remote.dto

import kotlinx.serialization.Serializable

@Serializable
data class SendSmsRequest(
    val to: String,
    val body: String,
    val from: String
)

@Serializable
data class SendSmsResponse(
    val id: String,
    val status: String
) {
    /** Alias for backward compatibility */
    val messageId: String get() = id
}

@Serializable
data class ConversationDto(
    val phoneNumber: String,
    val lastMessagePreview: String? = null,
    val lastMessageTimestamp: String? = null,
    val lastReceivedAt: String? = null,
    val lastReadAt: String? = null,
    val providerNumber: String? = null,
    val providerNumberLabel: String? = null
)

@Serializable
data class ConversationListResponse(
    val conversations: List<ConversationDto>
)

@Serializable
data class MessageDto(
    val id: String,
    val conversationNumber: String,
    val providerNumber: String? = null,
    val providerNumberLabel: String? = null,
    val body: String,
    val direction: String,
    val status: String,
    val timestamp: String
)

@Serializable
data class MessageListResponse(
    val messages: List<MessageDto>
)
