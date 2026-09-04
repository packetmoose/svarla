package app.svarla.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Persisted record of a currently-displayed notification.
 *
 * The [NotificationHandler] otherwise tracks displayed notifications only in
 * in-memory maps, which are lost when the process is killed. Persisting the
 * mapping (server notification UUID → Android notification id, plus enough
 * metadata to match it later) lets dismissal and de-duplication survive an app
 * restart. Records are rehydrated into the in-memory maps on cold start and
 * evicted once they exceed a TTL.
 */
@Entity(tableName = "active_notifications")
data class ActiveNotification(
    /** Server notification UUID (the key used by notification_updated events). */
    @PrimaryKey
    val serverId: String,
    /** The Android notification id passed to NotificationManager.notify(). */
    val androidId: Int,
    /** Notification type, e.g. "incoming_sms", "missed_call". */
    val type: String,
    /**
     * Normalized sender/caller phone number (last significant digits form) used
     * to match the notification to a conversation when dismissing. Null for
     * notifications without an associated number.
     */
    val normalizedNumber: String? = null,
    /** When the record was written (epoch millis), used for TTL eviction. */
    val createdAt: Long
)
