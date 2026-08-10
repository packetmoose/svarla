package app.svarla.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

enum class CallType {
    INCOMING,
    OUTGOING,
    MISSED,
    UNANSWERED,
    DECLINED,
    BLOCKED
}

@Entity(tableName = "call_history")
data class CallHistoryEntry(
    @PrimaryKey
    val id: String,
    val phoneNumber: String,
    val providerNumber: String? = null,
    val callType: CallType,
    val timestamp: Long,
    val durationSeconds: Int? = null,
    val answeredByDevice: String? = null,
    val realCallerNumber: String? = null
)
