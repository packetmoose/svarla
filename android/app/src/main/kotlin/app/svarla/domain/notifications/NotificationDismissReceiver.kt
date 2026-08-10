package app.svarla.domain.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import app.svarla.data.remote.api.ApiClient
import app.svarla.data.remote.api.ApiException
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Receives notification dismiss events (user swiped away a notification).
 * Marks the notification as read on the server so it doesn't reappear
 * when pending notifications are fetched on reconnect.
 *
 * If the server is unreachable, the notification ID is persisted locally
 * so it can be flushed on next app launch / WebSocket reconnect.
 */
class NotificationDismissReceiver : BroadcastReceiver() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface DismissEntryPoint {
        fun apiClient(): ApiClient
    }

    companion object {
        private const val TAG = "NotifDismissReceiver"
        const val ACTION_DISMISS = "app.svarla.ACTION_NOTIFICATION_DISMISSED"
        const val EXTRA_SERVER_NOTIFICATION_ID = "server_notification_id"

        private const val PREFS_NAME = "notification_dismiss_queue"
        private const val KEY_PENDING_DISMISSALS = "pending_ids"
        private const val KEY_DISMISSAL_TIMESTAMPS = "pending_timestamps"
        private const val MAX_QUEUED_DISMISSALS = 100
        private const val MAX_AGE_MS = 14L * 24 * 60 * 60 * 1000 // 14 days

        /**
         * Flush any queued dismissals that failed previously (e.g., no network).
         * Call this before fetching pending notifications on reconnect.
         */
        fun flushPendingDismissals(context: Context) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val pending = prefs.getStringSet(KEY_PENDING_DISMISSALS, null)
            if (pending.isNullOrEmpty()) return

            val entryPoint = EntryPointAccessors.fromApplication(
                context.applicationContext,
                DismissEntryPoint::class.java
            )
            val apiClient = entryPoint.apiClient()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

            // Copy and clear immediately to avoid duplicate flushes
            val toFlush = pending.toSet()
            prefs.edit().remove(KEY_PENDING_DISMISSALS).apply()

            scope.launch {
                val stillFailed = mutableSetOf<String>()
                for (id in toFlush) {
                    try {
                        apiClient.post<Unit>(path = "/api/notifications/$id/read")
                        Log.d(TAG, "Flushed queued dismissal: $id")
                    } catch (e: ApiException) {
                        if (e.statusCode == 404) {
                            // Notification no longer exists — discard silently
                            Log.d(TAG, "Queued dismissal $id returned 404, discarding")
                        } else {
                            Log.w(TAG, "Still cannot dismiss $id: ${e.message}")
                            stillFailed.add(id)
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "Still cannot dismiss $id: ${e.message}")
                        stillFailed.add(id)
                    }
                }
                // Re-persist any that still failed
                if (stillFailed.isNotEmpty()) {
                    prefs.edit().putStringSet(KEY_PENDING_DISMISSALS, stillFailed).apply()
                }
            }
        }

        /**
         * Returns the set of notification IDs that were dismissed locally but
         * not yet confirmed by the server. Used to filter them out of pending
         * notification fetches so they don't reappear.
         */
        fun getPendingDismissalIds(context: Context): Set<String> {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return prefs.getStringSet(KEY_PENDING_DISMISSALS, emptySet()) ?: emptySet()
        }

        private fun queueDismissal(context: Context, notificationId: String) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val current = prefs.getStringSet(KEY_PENDING_DISMISSALS, mutableSetOf()) ?: mutableSetOf()
            val timestamps = prefs.getString(KEY_DISMISSAL_TIMESTAMPS, "") ?: ""

            val updated = current.toMutableSet()
            updated.add(notificationId)

            // Parse timestamps map (id:epochMs,id:epochMs,...)
            val tsMap = parseTimestamps(timestamps).toMutableMap()
            tsMap[notificationId] = System.currentTimeMillis()

            // Evict entries older than MAX_AGE_MS
            val now = System.currentTimeMillis()
            val expired = tsMap.filter { now - it.value > MAX_AGE_MS }.keys
            updated.removeAll(expired)
            expired.forEach { tsMap.remove(it) }

            // Cap at MAX_QUEUED_DISMISSALS (remove oldest first)
            if (updated.size > MAX_QUEUED_DISMISSALS) {
                val sorted = tsMap.entries.sortedBy { it.value }
                val toRemove = sorted.take(updated.size - MAX_QUEUED_DISMISSALS).map { it.key }
                updated.removeAll(toRemove.toSet())
                toRemove.forEach { tsMap.remove(it) }
            }

            prefs.edit()
                .putStringSet(KEY_PENDING_DISMISSALS, updated)
                .putString(KEY_DISMISSAL_TIMESTAMPS, serializeTimestamps(tsMap))
                .apply()
        }

        private fun removeDismissal(context: Context, notificationId: String) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val current = prefs.getStringSet(KEY_PENDING_DISMISSALS, mutableSetOf()) ?: mutableSetOf()
            if (current.contains(notificationId)) {
                val updated = current.toMutableSet()
                updated.remove(notificationId)

                val timestamps = prefs.getString(KEY_DISMISSAL_TIMESTAMPS, "") ?: ""
                val tsMap = parseTimestamps(timestamps).toMutableMap()
                tsMap.remove(notificationId)

                prefs.edit()
                    .putStringSet(KEY_PENDING_DISMISSALS, updated)
                    .putString(KEY_DISMISSAL_TIMESTAMPS, serializeTimestamps(tsMap))
                    .apply()
            }
        }

        private fun parseTimestamps(raw: String): Map<String, Long> {
            if (raw.isEmpty()) return emptyMap()
            return raw.split(",").mapNotNull { entry ->
                val parts = entry.split(":", limit = 2)
                if (parts.size == 2) parts[0] to (parts[1].toLongOrNull() ?: 0L) else null
            }.toMap()
        }

        private fun serializeTimestamps(map: Map<String, Long>): String {
            return map.entries.joinToString(",") { "${it.key}:${it.value}" }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != ACTION_DISMISS) return

        val serverNotificationId = intent.getStringExtra(EXTRA_SERVER_NOTIFICATION_ID)
        if (serverNotificationId.isNullOrEmpty()) {
            Log.w(TAG, "Dismiss intent missing server notification ID")
            return
        }

        Log.d(TAG, "Notification dismissed by user: $serverNotificationId")

        // Persist immediately so it survives even if the process dies before the API call
        queueDismissal(context, serverNotificationId)

        val entryPoint = EntryPointAccessors.fromApplication(
            context.applicationContext,
            DismissEntryPoint::class.java
        )
        val apiClient = entryPoint.apiClient()

        scope.launch {
            try {
                apiClient.post<Unit>(
                    path = "/api/notifications/$serverNotificationId/read"
                )
                // Success — remove from the queue
                removeDismissal(context, serverNotificationId)
                Log.d(TAG, "Marked notification $serverNotificationId as read on server")
            } catch (e: ApiException) {
                if (e.statusCode == 404) {
                    // Notification no longer exists on the server — no point retrying
                    removeDismissal(context, serverNotificationId)
                    Log.d(TAG, "Notification $serverNotificationId not found (404), removing from retry queue")
                } else {
                    // Other API error — stays in the queue for later flush
                    Log.e(TAG, "Failed to mark notification as read (queued for retry): ${e.message}")
                }
            } catch (e: Exception) {
                // Network/other error — stays in the queue for later flush
                Log.e(TAG, "Failed to mark notification as read (queued for retry): ${e.message}")
            }
        }
    }
}
