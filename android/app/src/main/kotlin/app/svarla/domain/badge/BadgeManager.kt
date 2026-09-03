package app.svarla.domain.badge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.svarla.data.remote.api.ReadStateApi
import app.svarla.data.remote.dto.ReadStateCountsDto
import app.svarla.data.remote.sync.SyncManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import javax.inject.Inject
import javax.inject.Singleton

/**
 * BadgeManager observes the server-side Global_Read_State and manages:
 * 1. App icon badge count (via NotificationManagerCompat notification channel badges)
 * 2. Navigation badge state for Call History and Messages tabs
 *
 * Cross-device sync: listens for WebSocket `read_state_updated` events
 * to update badges when items are read on another device.
 *
 * Requirements covered: 15.1-15.12
 */
@Singleton
class BadgeManager @Inject constructor(
    private val context: Context,
    private val readStateApi: ReadStateApi,
    private val syncManager: SyncManager,
    private val json: Json
) {
    companion object {
        private const val TAG = "BadgeManager"
        private const val BADGE_CHANNEL_ID = "badge_channel"
        private const val BADGE_NOTIFICATION_ID = 9999
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _unseenMissedCalls = MutableStateFlow(0)
    val unseenMissedCalls: StateFlow<Int> = _unseenMissedCalls.asStateFlow()

    private val _unreadMessages = MutableStateFlow(0)
    val unreadMessages: StateFlow<Int> = _unreadMessages.asStateFlow()

    /**
     * Combined badge count for the app icon.
     */
    val totalBadgeCount: Int
        get() = _unseenMissedCalls.value + _unreadMessages.value

    /**
     * Whether to show a badge on the Call History navigation tab.
     */
    val hasCallHistoryBadge: Boolean
        get() = _unseenMissedCalls.value > 0

    /**
     * Whether to show a badge on the Messages navigation tab.
     */
    val hasMessagesBadge: Boolean
        get() = _unreadMessages.value > 0

    init {
        createNotificationChannel()
        observeWebSocketEvents()
    }

    /**
     * Initialize badge state by fetching current counts from server.
     * Should be called after authentication succeeds.
     */
    fun initialize() {
        scope.launch {
            try {
                val counts = readStateApi.getCounts()
                updateCounts(counts)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to fetch initial badge counts", e)
            }
        }
    }

    /**
     * Mark all missed calls as viewed.
     * Called when the user opens the Call History view.
     * Updates local state immediately and notifies server.
     */
    fun markMissedCallsAsViewed() {
        // Optimistic local update
        _unseenMissedCalls.value = 0
        updateAppIconBadge()

        scope.launch {
            try {
                val counts = readStateApi.markMissedCallsAsViewed()
                updateCounts(counts)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to mark missed calls as viewed", e)
                // Refresh from server on failure
                refreshCounts()
            }
        }
    }

    /**
     * Mark all messages in a thread as read.
     * Called when the user opens a Conversation_Thread.
     * Updates local state and notifies server.
     */
    fun markThreadAsRead(providerNumber: String, phoneNumber: String) {
        scope.launch {
            try {
                val counts = readStateApi.markThreadAsRead(providerNumber, phoneNumber)
                updateCounts(counts)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to mark thread as read: $providerNumber -> $phoneNumber", e)
                refreshCounts()
            }
        }
    }

    /**
     * Refresh badge counts from the server.
     */
    fun refreshCounts() {
        scope.launch {
            try {
                val counts = readStateApi.getCounts()
                updateCounts(counts)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to refresh badge counts", e)
            }
        }
    }

    /**
     * Update local counts and app icon badge from server response.
     */
    private fun updateCounts(counts: ReadStateCountsDto) {
        _unseenMissedCalls.value = counts.unseenMissedCalls
        _unreadMessages.value = counts.unreadMessages
        updateAppIconBadge()
    }

    /**
     * Update the launcher app icon badge using NotificationManagerCompat.
     * Uses the notification channel badge approach:
     * - Posts a notification with the combined count as the badge number
     * - Removes the notification (and badge) when count reaches zero
     *
     * Requirement 15.3, 15.6, 15.12
     */
    private fun updateAppIconBadge() {
        val total = _unseenMissedCalls.value + _unreadMessages.value

        val notificationManager = NotificationManagerCompat.from(context)

        if (total <= 0) {
            // Remove badge when count reaches zero (Requirement 15.6)
            notificationManager.cancel(BADGE_NOTIFICATION_ID)
            return
        }

        // Create a silent notification that sets the badge count
        val notification = NotificationCompat.Builder(context, BADGE_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Svarla")
            .setContentText("$total unread items")
            .setNumber(total)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .build()

        try {
            notificationManager.notify(BADGE_NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "Missing notification permission for badge update", e)
        }
    }

    /**
     * Create the notification channel for badge display.
     * Configured to show badge count but remain silent.
     */
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                BADGE_CHANNEL_ID,
                "Badge Indicators",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Used for app icon badge count display"
                setShowBadge(true)
                enableLights(false)
                enableVibration(false)
                setSound(null, null)
            }

            val notificationManager = context.getSystemService(NotificationManager::class.java)
            notificationManager?.createNotificationChannel(channel)
        }
    }

    /**
     * Observe WebSocket events for cross-device read state sync.
     * When another device marks items as read, we receive a read_state_updated event.
     */
    private fun observeWebSocketEvents() {
        scope.launch {
            syncManager.events.collect { event ->
                if (event.type == "read_state_updated") {
                    try {
                        val data = event.data
                        if (data != null) {
                            val obj = data.jsonObject
                            val unreadMessages = obj["unreadMessages"]?.jsonPrimitive?.int ?: 0
                            val unseenMissedCalls = obj["unseenMissedCalls"]?.jsonPrimitive?.int ?: 0
                            updateCounts(
                                ReadStateCountsDto(
                                    unreadMessages = unreadMessages,
                                    unseenMissedCalls = unseenMissedCalls
                                )
                            )
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to parse read_state_updated event", e)
                        // Fallback: refresh from server
                        refreshCounts()
                    }
                }
            }
        }
    }
}
