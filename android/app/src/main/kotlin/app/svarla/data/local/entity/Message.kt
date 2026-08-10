package app.svarla.data.local.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

enum class MessageDirection {
    SENT,
    RECEIVED
}

enum class MessageStatus {
    PENDING,
    SENT,
    DELIVERED,
    FAILED,
    QUEUED
}

@Entity(
    tableName = "messages",
    indices = [
        Index(value = ["conversationNumber", "timestamp"]),
        Index(value = ["providerMessageId"], unique = true)
    ]
)
data class Message(
    @PrimaryKey
    val id: String,
    val providerMessageId: String? = null,
    val conversationNumber: String,
    val providerNumber: String? = null,
    val body: String,
    val direction: MessageDirection,
    val status: MessageStatus,
    val timestamp: Long,
    val retryCount: Int = 0
)
