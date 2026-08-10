package app.svarla.data.local.entity

import androidx.room.Entity

@Entity(tableName = "conversations", primaryKeys = ["providerNumber", "phoneNumber"])
data class Conversation(
    val providerNumber: String,
    val phoneNumber: String,
    val lastMessagePreview: String? = null,
    val lastMessageTimestamp: Long? = null,
    val lastReceivedAt: Long? = null,
    val lastReadAt: Long? = null,
    val createdAt: Long
)
