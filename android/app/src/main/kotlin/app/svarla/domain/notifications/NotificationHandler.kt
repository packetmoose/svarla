package app.svarla.domain.notifications

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.svarla.MainActivity
import app.svarla.R
import app.svarla.data.remote.api.NotificationsApi
import app.svarla.data.remote.dto.WebSocketEvent
import app.svarla.data.remote.sync.SyncManager
import app.svarla.domain.call.CallActionReceiver
import app.svarla.domain.call.CallStatus
import app.svarla.domain.call.VoiceCallManager
import app.svarla.domain.contacts.ContactResolver
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Payload types for push notifications delivered via ntfy/UnifiedPush.
 */
@Serializable
data class PushNotificationPayload(
    val type: String, // "incoming_call", "incoming_sms", "missed_call"
    val id: String, // Notification ID for deduplication
    val callId: String? = null,
    val from: String? = null,
    val to: String? = null,
    val providerNumber: String? = null,
    val providerNumberLabel: String? = null,
    val contactName: String? = null,
    val messagePreview: String? = null,
    val timestamp: Long? = null
)

/**
 * Handles all push notifications for the Svarla app.
 *
 * Responsibilities:
 * - UnifiedPush/ntfy subscription management
 * - Incoming call notifications (high priority, heads-up, sound + vibration, ringtone)
 * - SMS notifications (default priority, sender name/number, message preview)
 * - Missed call notifications (default priority, caller info + time)
 * - Notification tap handling (open call screen or conversation thread)
 * - Notification dismissal when user views relevant content
 * - Server notification ID-based tracking (server UUID → Android notification ID)
 * - Handling server-sent notification_created and notification_updated events
 *
 * Requirements covered: 5.1, 5.2, 5.3, 5.4, 5.6, 2.1, 2.3, 4.1, 4.2, 6.5, 9.5
 */
@Singleton
class NotificationHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val voiceCallManager: VoiceCallManager,
    private val contactResolver: ContactResolver,
    private val missedCallNotifier: MissedCallNotifier,
    private val newDeviceLoginNotifier: NewDeviceLoginNotifier,
    private val syncManager: SyncManager,
    private val notificationsApi: NotificationsApi,
    private val activeNotificationDao: app.svarla.data.local.dao.ActiveNotificationDao,
    private val conversationDao: app.svarla.data.local.dao.ConversationDao,
    private val json: Json
) {
    companion object {
        private const val TAG = "NotificationHandler"

        // Notification ID ranges to avoid collisions
        private const val CALL_NOTIFICATION_ID_BASE = 1000
        private const val SMS_NOTIFICATION_ID_BASE = 2000
        private const val MISSED_CALL_NOTIFICATION_ID_BASE = 3000

        // Intent extras for tap handling
        const val EXTRA_NOTIFICATION_TYPE = "notification_type"
        const val EXTRA_CALL_ID = "call_id"
        const val EXTRA_PHONE_NUMBER = "phone_number"
        const val EXTRA_PROVIDER_NUMBER = "provider_number"
        const val EXTRA_NOTIFICATION_ID = "notification_id"

        // Notification types for intent handling
        const val TYPE_INCOMING_CALL = "incoming_call"
        const val TYPE_INCOMING_SMS = "incoming_sms"
        const val TYPE_MISSED_CALL = "missed_call"
        const val TYPE_BLOCKED_CALL = "blocked_call"
        const val TYPE_NEW_DEVICE_LOGIN = "new_device_login"

        // Action constants for call notification
        const val ACTION_ANSWER_CALL = "app.svarla.ACTION_ANSWER_CALL"
        const val ACTION_DECLINE_CALL = "app.svarla.ACTION_DECLINE_CALL"

        // Notification group for missed/blocked calls
        private const val GROUP_MISSED_CALLS = "app.svarla.GROUP_MISSED_CALLS"

        // Number of trailing digits used to match phone numbers across formats
        // (e.g. "+46701234567" vs "0701234567").
        private const val NUMBER_MATCH_DIGITS = 7

        // Records older than this are evicted from the persisted active-notification
        // table on rehydration.
        private const val ACTIVE_NOTIFICATION_TTL_MS = 48L * 60 * 60 * 1000
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /**
     * Maps server notification UUID to Android notification ID.
     * Used to update or dismiss notifications when the server sends
     * `notification_updated` events (e.g., status changed to `read` or type changed).
     * This replaces the former client-side deduplication via shownNotificationIds.
     */
    private val serverNotificationIdMap = ConcurrentHashMap<String, Int>()

    /**
     * Caches the original notification type for each tracked server notification ID.
     * Used to detect type changes in `notification_updated` events so we can
     * update the displayed notification content in-place.
     */
    private val serverNotificationTypeMap = ConcurrentHashMap<String, String>()

    /**
     * Caches the original [NotificationCreatedEvent] payload for each tracked server
     * notification ID. Used to rebuild notification content when the type changes
     * (e.g., `incoming_call` → `missed_call`) without having to re-fetch from the server.
     */
    private val serverNotificationPayloadCache = ConcurrentHashMap<String, NotificationCreatedEvent>()

    /** Counter for generating unique Android notification IDs within each range. */
    private var callNotificationCounter = 0
    private var smsNotificationCounter = 0
    private var missedCallNotificationCounter = 0

    private val notificationManager: NotificationManagerCompat by lazy {
        NotificationManagerCompat.from(context)
    }

    // ========================================================================
    // UnifiedPush Registration
    // ========================================================================

    /**
     * Register this device for push notifications.
     * Creates notification channels. Push delivery is managed by PushEndpointManager
     * via UnifiedPush.
     */
    fun registerForPush() {
        try {
            NotificationChannels.createAll(context)
            Log.d(TAG, "Notification channels created")
            rehydrateActiveNotifications()
            observeWebSocketEvents()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create notification channels", e)
        }
    }

    /**
     * Rehydrates the in-memory tracking maps from the persisted active-notification
     * table on cold start, so notifications posted by a previous process can still
     * be located for dismissal and de-duplication. Evicts stale records first.
     *
     * Only the id→androidId and id→type maps are restored; the full payload cache
     * is not persisted (matching now falls back to the persisted normalizedNumber
     * and the messages-channel activeNotifications scan).
     */
    private fun rehydrateActiveNotifications() {
        scope.launch(Dispatchers.IO) {
            try {
                val cutoff = System.currentTimeMillis() - ACTIVE_NOTIFICATION_TTL_MS
                activeNotificationDao.deleteOlderThan(cutoff)
                val records = activeNotificationDao.getAll()
                for (record in records) {
                    serverNotificationIdMap[record.serverId] = record.androidId
                    serverNotificationTypeMap[record.serverId] = record.type
                }
                Log.d(TAG, "Rehydrated ${records.size} persisted notification record(s)")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to rehydrate persisted notifications", e)
            }
        }
    }

    /**
     * Unregister from push notifications.
     */
    fun unregisterFromPush() {
        Log.d(TAG, "Push notifications unregistered")
    }

    // ========================================================================
    // WebSocket Event Observation
    // ========================================================================

    /**
     * Observes WebSocket events from [SyncManager] and dispatches
     * `notification_created` and `notification_updated` events to their
     * respective handlers. Also handles WebSocket reconnection by fetching
     * pending notifications from the server API.
     */
    private fun observeWebSocketEvents() {
        scope.launch {
            syncManager.events.collect { event ->
                when (event.type) {
                    "connected" -> {
                        // WebSocket reconnected — fetch pending notifications from the server
                        fetchPendingNotificationsOnReconnect()
                    }
                    "notification_created" -> {
                        val data = event.data ?: return@collect
                        try {
                            val payload = json.decodeFromJsonElement<NotificationCreatedEvent>(data)
                            handleNotificationCreated(payload)
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to parse notification_created event", e)
                        }
                    }
                    "notification_updated" -> {
                        val data = event.data ?: return@collect
                        try {
                            val payload = json.decodeFromJsonElement<NotificationUpdatedEvent>(data)
                            handleNotificationUpdated(payload)
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to parse notification_updated event", e)
                        }
                    }
                }
            }
        }
    }

    /**
     * Fetches all pending notifications from `GET /api/notifications` on WebSocket reconnect
     * and shows each one via [handleNotificationCreated].
     *
     * This ensures notifications that were missed while the device was offline are displayed.
     * Notifications that are already being displayed (tracked by server ID) will be handled
     * gracefully by [handleNotificationCreated] — incoming_call notifications for calls already
     * ringing will simply enrich the existing call info rather than creating duplicates.
     *
     * Requirements: 5.3, 5.5
     */
    private fun fetchPendingNotificationsOnReconnect() {
        scope.launch(Dispatchers.IO) {
            try {
                // Flush any queued dismissals that failed while offline
                NotificationDismissReceiver.flushPendingDismissals(context)

                Log.d(TAG, "WebSocket reconnected, fetching pending notifications")
                val pendingNotifications = notificationsApi.getPendingNotifications()
                Log.d(TAG, "Fetched ${pendingNotifications.size} pending notification(s) on reconnect")

                // Filter out notifications that were dismissed locally but not yet confirmed
                val locallyDismissed = NotificationDismissReceiver.getPendingDismissalIds(context)
                val notLocallyDismissed = if (locallyDismissed.isEmpty()) {
                    pendingNotifications
                } else {
                    pendingNotifications.filter { it.id !in locallyDismissed }
                }

                // Defense-in-depth for already-read items (in case the server hasn't
                // yet reconciled the notification's status with thread read-state):
                // skip an incoming_sms notification whose conversation was read locally
                // after the notification was created.
                val toShow = notLocallyDismissed.filter { notification ->
                    if (notification.type != TYPE_INCOMING_SMS) return@filter true
                    !isSmsNotificationAlreadyRead(notification)
                }

                for (notification in toShow) {
                    val event = notification.toNotificationCreatedEvent()
                    // Switch to Main for notification display (Android requires main thread for some ops)
                    withContext(Dispatchers.Main) {
                        handleNotificationCreated(event)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to fetch pending notifications on reconnect", e)
            }
        }
    }

    /**
     * Returns true if this pending SMS notification corresponds to a conversation
     * that was already read locally after the notification was created — meaning it
     * should not be re-posted on reconnect / cold start.
     */
    private suspend fun isSmsNotificationAlreadyRead(notification: NotificationApiResponse): Boolean {
        return try {
            val senderNumber = notification.payload?.let {
                try { it.jsonObject["senderNumber"]?.jsonPrimitive?.contentOrNull } catch (_: Exception) { null }
            } ?: return false

            val createdAtMs = notification.createdAt?.let { parseIsoToEpochMillis(it) } ?: return false

            val matchKey = numberMatchKey(senderNumber)
            val conversation = conversationDao.getByNumber(senderNumber)
                ?: conversationDao.getAllOnce().firstOrNull { numberMatchKey(it.phoneNumber) == matchKey }
                ?: return false

            val lastReadAt = conversation.lastReadAt ?: return false
            // Already read if the thread was read at/after the notification was created.
            lastReadAt >= createdAtMs
        } catch (e: Exception) {
            Log.w(TAG, "Failed to evaluate read-state for pending notification ${notification.id}", e)
            false
        }
    }

    private fun parseIsoToEpochMillis(iso: String): Long? {
        return try {
            java.time.Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }

    // ========================================================================
    // Server Notification Event Handlers
    // ========================================================================

    /**
     * Handles a `notification_created` event from the server.
     * Shows or updates an Android notification based on the notification type.
     * Dispatches to type-specific notification builders and tracks the server
     * notification ID for subsequent update/dismiss events.
     *
     * Requirements: 4.1, 6.3, 6.4
     */
    fun handleNotificationCreated(payload: NotificationCreatedEvent) {
        Log.d(TAG, "handleNotificationCreated: id=${payload.id}, type=${payload.notificationType}, status=${payload.status}")

        val nestedPayload = payload.payload?.jsonObject

        when (payload.notificationType) {
            TYPE_INCOMING_CALL -> {
                val callerNumber = nestedPayload?.get("callerNumber")?.jsonPrimitive?.contentOrNull ?: "Unknown"
                val providerNumber = nestedPayload?.get("providerNumber")?.jsonPrimitive?.contentOrNull ?: ""
                val providerLabel = nestedPayload?.get("providerLabel")?.jsonPrimitive?.contentOrNull
                val contactName = nestedPayload?.get("contactName")?.jsonPrimitive?.contentOrNull

                // Forward to VoiceCallManager (same logic as handleIncomingCallNotification)
                val currentCallState = voiceCallManager.callState.value

                // If already ringing for this call, enrich call info.
                // The Telecom path may have started ringing using the notification ID
                // (from the wake signal) as a temporary callId. When the notification fetch
                // or WebSocket delivers the full notification, sourceEntityId contains the
                // real call ID. Match on either sourceEntityId OR notification id (payload.id).
                if (currentCallState.status == CallStatus.RINGING &&
                    (currentCallState.activeCallInfo?.callId == payload.sourceEntityId ||
                     currentCallState.activeCallInfo?.callId == payload.id)
                ) {
                    Log.d(TAG, "Incoming call ${payload.sourceEntityId} already ringing, enriching call info (current callId=${currentCallState.activeCallInfo?.callId})")
                    voiceCallManager.handleIncomingCall(
                        callId = payload.sourceEntityId,
                        fromNumber = callerNumber,
                        providerNumber = providerNumber,
                        providerNumberLabel = providerLabel
                    )
                    return
                }

                // If not IDLE, ignore
                if (currentCallState.status != CallStatus.IDLE) {
                    Log.d(TAG, "Incoming call ${payload.sourceEntityId} ignored: state is ${currentCallState.status}")
                    return
                }

                // Forward to VoiceCallManager to transition state to RINGING
                voiceCallManager.handleIncomingCall(
                    callId = payload.sourceEntityId,
                    fromNumber = callerNumber,
                    providerNumber = providerNumber,
                    providerNumberLabel = providerLabel
                )

                val displayName = contactName
                    ?: contactResolver.resolveContactName(callerNumber)
                    ?: callerNumber

                val androidNotificationId = CALL_NOTIFICATION_ID_BASE + (++callNotificationCounter % 100)

                // Full-screen intent for incoming call
                val fullScreenIntent = app.svarla.IncomingCallActivity.createIntent(context, payload.sourceEntityId, callerNumber)
                val fullScreenPendingIntent = PendingIntent.getActivity(
                    context,
                    androidNotificationId,
                    fullScreenIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )

                // Answer action intent
                val answerIntent = Intent(context, MainActivity::class.java).apply {
                    action = ACTION_ANSWER_CALL
                    putExtra(EXTRA_CALL_ID, payload.sourceEntityId)
                    putExtra(EXTRA_NOTIFICATION_ID, androidNotificationId)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
                val answerPendingIntent = PendingIntent.getActivity(
                    context,
                    androidNotificationId + 1000,
                    answerIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )

                // Decline action intent
                val declineIntent = Intent(context, CallActionReceiver::class.java).apply {
                    action = CallActionReceiver.ACTION_DECLINE
                    putExtra(EXTRA_CALL_ID, payload.sourceEntityId)
                }
                val declinePendingIntent = PendingIntent.getBroadcast(
                    context,
                    androidNotificationId + 2000,
                    declineIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )

                val contentText = if (!providerLabel.isNullOrEmpty()) {
                    "Incoming call on $providerLabel"
                } else {
                    "Incoming call"
                }

                val caller = androidx.core.app.Person.Builder()
                    .setName(displayName)
                    .setImportant(true)
                    .build()

                val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_CALLS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(displayName)
                    .setContentText(contentText)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .setSilent(true)
                    .setContentIntent(fullScreenPendingIntent)
                    .setFullScreenIntent(fullScreenPendingIntent, true)
                    .setStyle(
                        NotificationCompat.CallStyle.forIncomingCall(
                            caller,
                            declinePendingIntent,
                            answerPendingIntent
                        )
                    )
                    .build()

                showNotification(payload.id, androidNotificationId, notification)
                trackServerNotification(payload.id, androidNotificationId, TYPE_INCOMING_CALL, payload)
                // Suppress the heads-up notification when app is in the foreground —
                // the full-screen incoming call UI is already visible.
                if (app.svarla.SvarlaApplication.isInForeground) {
                    Log.d(TAG, "App is in foreground, cancelling incoming call notification to avoid overlap")
                    notificationManager.cancel(androidNotificationId)
                }
                Log.d(TAG, "Showing incoming call notification: ${payload.sourceEntityId} from $displayName")
            }

            TYPE_INCOMING_SMS -> {
                // Deduplicate: if we've already shown a notification for this server ID
                // (e.g., received via both push fetch and WebSocket), skip it.
                if (serverNotificationIdMap.containsKey(payload.id)) {
                    Log.d(TAG, "SMS notification ${payload.id} already displayed, skipping duplicate")
                    return
                }

                val senderNumber = nestedPayload?.get("senderNumber")?.jsonPrimitive?.contentOrNull ?: "Unknown"
                val providerNumber = nestedPayload?.get("providerNumber")?.jsonPrimitive?.contentOrNull
                val providerLabel = nestedPayload?.get("providerLabel")?.jsonPrimitive?.contentOrNull ?: ""
                val contactName = nestedPayload?.get("contactName")?.jsonPrimitive?.contentOrNull
                val messagePreview = nestedPayload?.get("messagePreview")?.jsonPrimitive?.contentOrNull ?: "New message"

                val displayName = contactName
                    ?: contactResolver.resolveContactName(senderNumber)
                    ?: senderNumber

                val androidNotificationId = SMS_NOTIFICATION_ID_BASE + (++smsNotificationCounter % 500)

                val tapIntent = createTapIntent(
                    notificationType = TYPE_INCOMING_SMS,
                    phoneNumber = senderNumber,
                    providerNumber = providerNumber,
                    notificationId = androidNotificationId
                )

                val title = if (providerLabel.isNotEmpty()) {
                    "$displayName → $providerLabel"
                } else {
                    displayName
                }

                val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_MESSAGES)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(title)
                    .setContentText(messagePreview)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(messagePreview))
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .setAutoCancel(true)
                    .setContentIntent(tapIntent)
                    .setDeleteIntent(createDismissIntent(payload.id, androidNotificationId))
                    .build()

                showNotification(payload.id, androidNotificationId, notification)
                trackServerNotification(payload.id, androidNotificationId, TYPE_INCOMING_SMS, payload)
                Log.d(TAG, "Showing SMS notification from $displayName")
            }

            TYPE_MISSED_CALL -> {
                val callerNumber = nestedPayload?.get("callerNumber")?.jsonPrimitive?.contentOrNull ?: "Unknown"
                val providerNumber = nestedPayload?.get("providerNumber")?.jsonPrimitive?.contentOrNull ?: ""
                val providerLabel = nestedPayload?.get("providerLabel")?.jsonPrimitive?.contentOrNull ?: ""
                val contactName = nestedPayload?.get("contactName")?.jsonPrimitive?.contentOrNull
                val timestamp = nestedPayload?.get("timestamp")?.jsonPrimitive?.contentOrNull

                val displayName = contactName
                    ?: contactResolver.resolveContactName(callerNumber)
                    ?: callerNumber

                val androidNotificationId = MISSED_CALL_NOTIFICATION_ID_BASE + (++missedCallNotificationCounter % 500)

                val tapIntent = createTapIntent(
                    notificationType = TYPE_MISSED_CALL,
                    phoneNumber = callerNumber,
                    notificationId = androidNotificationId
                )

                val callTime = timestamp?.let { ts ->
                    try {
                        val instant = java.time.Instant.parse(ts)
                        val sdf = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
                        sdf.timeZone = java.util.TimeZone.getDefault()
                        sdf.format(java.util.Date(instant.toEpochMilli()))
                    } catch (_: Exception) { "" }
                } ?: ""

                val callTimestampMillis = timestamp?.let { ts ->
                    try { java.time.Instant.parse(ts).toEpochMilli() } catch (_: Exception) { null }
                }

                val contentText = buildString {
                    append("Missed call")
                    if (providerLabel.isNotEmpty()) append(" on $providerLabel")
                    else if (providerNumber.isNotEmpty()) append(" to $providerNumber")
                    if (callTime.isNotEmpty()) append(" at $callTime")
                }

                val builder = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_MISSED_CALLS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(displayName)
                    .setContentText(contentText)
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                    .setAutoCancel(true)
                    .setContentIntent(tapIntent)
                    .setGroup(GROUP_MISSED_CALLS)
                    .setDeleteIntent(createDismissIntent(payload.id, androidNotificationId))

                if (callTimestampMillis != null) {
                    builder.setWhen(callTimestampMillis)
                    builder.setShowWhen(true)
                }

                val notification = builder.build()

                showNotification(payload.id, androidNotificationId, notification)
                trackServerNotification(payload.id, androidNotificationId, TYPE_MISSED_CALL, payload)
                Log.d(TAG, "Showing missed call notification from $displayName")
            }

            TYPE_BLOCKED_CALL -> {
                val callerNumber = nestedPayload?.get("callerNumber")?.jsonPrimitive?.contentOrNull ?: "Unknown"
                val providerNumber = nestedPayload?.get("providerNumber")?.jsonPrimitive?.contentOrNull ?: ""
                val providerLabel = nestedPayload?.get("providerLabel")?.jsonPrimitive?.contentOrNull ?: ""
                val contactName = nestedPayload?.get("contactName")?.jsonPrimitive?.contentOrNull

                val displayName = contactName
                    ?: contactResolver.resolveContactName(callerNumber)
                    ?: callerNumber

                val androidNotificationId = MISSED_CALL_NOTIFICATION_ID_BASE + (++missedCallNotificationCounter % 500)

                val tapIntent = createTapIntent(
                    notificationType = TYPE_BLOCKED_CALL,
                    phoneNumber = callerNumber,
                    notificationId = androidNotificationId
                )

                val contentText = buildString {
                    append("Blocked call")
                    if (providerLabel.isNotEmpty()) {
                        append(" on $providerLabel")
                    } else if (providerNumber.isNotEmpty()) {
                        append(" to $providerNumber")
                    }
                }

                val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_MISSED_CALLS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(displayName)
                    .setContentText(contentText)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setAutoCancel(true)
                    .setContentIntent(tapIntent)
                    .setGroup(GROUP_MISSED_CALLS)
                    .setDeleteIntent(createDismissIntent(payload.id, androidNotificationId))
                    .build()

                showNotification(payload.id, androidNotificationId, notification)
                trackServerNotification(payload.id, androidNotificationId, TYPE_BLOCKED_CALL, payload)
                Log.d(TAG, "Showing blocked call notification from $displayName")
            }

            TYPE_NEW_DEVICE_LOGIN -> {
                val deviceId = nestedPayload?.get("deviceId")?.jsonPrimitive?.contentOrNull ?: payload.sourceEntityId
                val deviceLabel = nestedPayload?.get("deviceLabel")?.jsonPrimitive?.contentOrNull ?: "Unknown device"

                newDeviceLoginNotifier.showNewDeviceLoginNotification(deviceId, deviceLabel)
                Log.d(TAG, "New device login notification delegated for: $deviceLabel")
            }

            else -> Log.w(TAG, "Unknown notification type: ${payload.notificationType}")
        }
    }

    /**
     * Handles a `notification_updated` event from the server.
     * Updates the displayed notification content (on type change) or dismisses
     * it (on status change to `read`).
     *
     * If no displayed notification matches the server notification `id`,
     * the event is silently ignored (requirement 6.6).
     *
     * Requirements: 4.2, 6.3, 6.4, 6.6
     */
    fun handleNotificationUpdated(payload: NotificationUpdatedEvent) {
        Log.d(TAG, "handleNotificationUpdated: id=${payload.id}, type=${payload.notificationType}, status=${payload.status}")

        // Requirement 6.6: If no displayed notification matches the id, ignore silently
        val androidNotificationId = serverNotificationIdMap[payload.id]
        if (androidNotificationId == null) {
            Log.d(TAG, "No displayed notification for server id=${payload.id}, ignoring")
            return
        }

        // Requirement 6.3: If status is 'read', dismiss the Android notification
        if (payload.status == "read") {
            Log.d(TAG, "Dismissing notification for server id=${payload.id} (status=read)")
            notificationManager.cancel(androidNotificationId)
            untrackServerNotification(payload.id)
            return
        }

        // Requirement 6.4: If the type changed, update the notification content in-place
        val newType = payload.notificationType
        val previousType = serverNotificationTypeMap[payload.id]
        if (newType != null && newType != previousType) {
            // If the incoming_call is transitioning to missed_call but the user declined it,
            // dismiss the notification entirely instead of updating it.
            if (newType == TYPE_MISSED_CALL) {
                val cachedPayload = serverNotificationPayloadCache[payload.id]
                val callId = cachedPayload?.sourceEntityId
                val fromNumber = cachedPayload?.payload?.let { p ->
                    try { p.jsonObject["callerNumber"]?.jsonPrimitive?.contentOrNull } catch (_: Exception) { null }
                }
                if ((callId != null && voiceCallManager.wasCallDeclined(callId)) ||
                    (fromNumber != null && voiceCallManager.wasRecentCallDeclinedFrom(fromNumber))
                ) {
                    Log.d(TAG, "Suppressing missed_call type change for declined call: id=${payload.id}, callId=$callId")
                    notificationManager.cancel(androidNotificationId)
                    untrackServerNotification(payload.id)
                    return
                }
            }

            Log.d(TAG, "Type changed for server id=${payload.id}: $previousType → $newType")
            updateNotificationForTypeChange(payload.id, androidNotificationId, newType)
            // Update the cached type
            serverNotificationTypeMap[payload.id] = newType
        }
    }

    /**
     * Rebuilds and re-posts a notification with updated content to reflect a type change.
     * Uses the cached [NotificationCreatedEvent] payload to reconstruct display data.
     *
     * For example, when an `incoming_call` transitions to `missed_call`, the notification
     * changes from "Incoming call" to "Missed call" using the same Android notification ID
     * so it updates in-place without creating a second notification.
     */
    private fun updateNotificationForTypeChange(
        serverNotificationId: String,
        androidNotificationId: Int,
        newType: String
    ) {
        val cachedEvent = serverNotificationPayloadCache[serverNotificationId]

        // Extract display info from cached payload or use defaults
        val callerNumber = cachedEvent?.let { extractPayloadField(it, "callerNumber") }
            ?: cachedEvent?.let { extractPayloadField(it, "senderNumber") }
            ?: "Unknown"
        val providerLabel = cachedEvent?.let { extractPayloadField(it, "providerLabel") } ?: ""
        val contactName = cachedEvent?.let { extractPayloadField(it, "contactName") }
        val displayName = contactName ?: callerNumber

        val (channelId, contentText, category) = when (newType) {
            TYPE_MISSED_CALL -> Triple(
                NotificationChannels.CHANNEL_ID_MISSED_CALLS,
                buildString {
                    append("Missed call")
                    if (providerLabel.isNotEmpty()) append(" on $providerLabel")
                },
                NotificationCompat.CATEGORY_MISSED_CALL
            )
            TYPE_BLOCKED_CALL -> Triple(
                NotificationChannels.CHANNEL_ID_MISSED_CALLS,
                buildString {
                    append("Blocked call")
                    if (providerLabel.isNotEmpty()) append(" on $providerLabel")
                },
                NotificationCompat.CATEGORY_MISSED_CALL
            )
            TYPE_INCOMING_SMS -> Triple(
                NotificationChannels.CHANNEL_ID_MESSAGES,
                cachedEvent?.let { extractPayloadField(it, "messagePreview") } ?: "New message",
                NotificationCompat.CATEGORY_MESSAGE
            )
            TYPE_INCOMING_CALL -> Triple(
                NotificationChannels.CHANNEL_ID_CALLS,
                buildString {
                    append("Incoming call")
                    if (providerLabel.isNotEmpty()) append(" on $providerLabel")
                },
                NotificationCompat.CATEGORY_CALL
            )
            else -> Triple(
                NotificationChannels.CHANNEL_ID_MISSED_CALLS,
                "Notification",
                NotificationCompat.CATEGORY_STATUS
            )
        }

        val tapIntent = createTapIntent(
            notificationType = newType,
            phoneNumber = callerNumber,
            notificationId = androidNotificationId
        )

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(displayName)
            .setContentText(contentText)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(category)
            .setAutoCancel(true)
            .setContentIntent(tapIntent)
            .setGroup(GROUP_MISSED_CALLS)
            .build()

        try {
            notificationManager.notify(androidNotificationId, notification)
            Log.d(TAG, "Updated notification in-place for server id=$serverNotificationId, new type=$newType")
        } catch (e: SecurityException) {
            Log.e(TAG, "Missing POST_NOTIFICATIONS permission", e)
        }
    }

    /**
     * Extracts a string field from the cached [NotificationCreatedEvent]'s JSONB payload.
     * Returns null if the field is not present or is a JSON null.
     */
    private fun extractPayloadField(event: NotificationCreatedEvent, fieldName: String): String? {
        val payloadElement = event.payload ?: return null
        return try {
            val jsonObject = payloadElement.jsonObject
            val element = jsonObject[fieldName] ?: return null
            element.jsonPrimitive.contentOrNull
        } catch (e: Exception) {
            null
        }
    }

    // ========================================================================
    // Server Notification ID Mapping
    // ========================================================================

    /**
     * Registers a mapping from a server notification UUID to an Android notification ID.
     * Called when displaying a notification so that subsequent `notification_updated`
     * events can locate the correct Android notification to update or dismiss.
     */
    fun trackServerNotification(serverNotificationId: String, androidNotificationId: Int) {
        serverNotificationIdMap[serverNotificationId] = androidNotificationId
    }

    /**
     * Registers a mapping and caches the notification type and original event payload.
     * Called when displaying a notification created from a server event, so that
     * subsequent `notification_updated` events can rebuild notification content
     * if the type changes.
     */
    fun trackServerNotification(
        serverNotificationId: String,
        androidNotificationId: Int,
        notificationType: String,
        event: NotificationCreatedEvent
    ) {
        serverNotificationIdMap[serverNotificationId] = androidNotificationId
        serverNotificationTypeMap[serverNotificationId] = notificationType
        serverNotificationPayloadCache[serverNotificationId] = event

        // Persist so dismissal/de-dup survives process death. Extract the number
        // (sender for SMS, caller for calls) so we can match by conversation later.
        val rawNumber = extractPayloadField(event, "senderNumber")
            ?: extractPayloadField(event, "callerNumber")
        val record = app.svarla.data.local.entity.ActiveNotification(
            serverId = serverNotificationId,
            androidId = androidNotificationId,
            type = notificationType,
            normalizedNumber = rawNumber?.let { numberMatchKey(it) },
            createdAt = System.currentTimeMillis()
        )
        scope.launch(Dispatchers.IO) {
            try {
                activeNotificationDao.upsert(record)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to persist active notification $serverNotificationId", e)
            }
        }
    }

    /**
     * Removes the mapping for a server notification UUID.
     * Called when a notification is dismissed or cancelled.
     */
    fun untrackServerNotification(serverNotificationId: String) {
        serverNotificationIdMap.remove(serverNotificationId)
        serverNotificationTypeMap.remove(serverNotificationId)
        serverNotificationPayloadCache.remove(serverNotificationId)
        scope.launch(Dispatchers.IO) {
            try {
                activeNotificationDao.deleteByServerId(serverNotificationId)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to remove persisted active notification $serverNotificationId", e)
            }
        }
    }

    /**
     * Returns the Android notification ID for a given server notification UUID,
     * or null if no mapping exists.
     */
    fun getAndroidNotificationId(serverNotificationId: String): Int? {
        return serverNotificationIdMap[serverNotificationId]
    }

    // ========================================================================
    // Notification Processing
    // ========================================================================

    /**
     * Process a raw push notification message received from UnifiedPush.
     * Parses the payload and dispatches to the appropriate handler.
     */
    fun handlePushMessage(message: String) {
        Log.d(TAG, "Received push message")

        val payload = try {
            json.decodeFromString<PushNotificationPayload>(message)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse push notification payload", e)
            return
        }

        when (payload.type) {
            TYPE_INCOMING_CALL -> handleIncomingCallNotification(payload)
            TYPE_INCOMING_SMS -> handleSmsNotification(payload)
            TYPE_MISSED_CALL -> handleMissedCallNotification(payload)
            TYPE_BLOCKED_CALL -> handleBlockedCallNotification(payload)
            TYPE_NEW_DEVICE_LOGIN -> handleNewDeviceLoginNotification(payload)
            else -> Log.w(TAG, "Unknown notification type: ${payload.type}")
        }
    }

    // ========================================================================
    // Incoming Call Notification
    // ========================================================================

    /**
     * Shows a high-priority incoming call notification with heads-up display,
     * ringtone sound, and vibration. Includes Answer and Decline action buttons.
     *
     * Forwards the call to VoiceCallManager when state is IDLE to transition
     * the call state to RINGING. If another call is active (state is not IDLE),
     * the notification is ignored.
     *
     * Requirements: 7.1, 7.8, 10.4, 10.5
     */
    private fun handleIncomingCallNotification(payload: PushNotificationPayload) {
        val callId = payload.callId ?: return
        val fromNumber = payload.from ?: "Unknown"
        val providerNumber = payload.providerNumber ?: ""
        val providerNumberLabel = payload.providerNumberLabel

        // If the call is already RINGING for this callId (Telecom path started it),
        // enrich the call info with full details from the notification payload.
        val currentCallState = voiceCallManager.callState.value
        if (currentCallState.status == CallStatus.RINGING &&
            currentCallState.activeCallInfo?.callId == callId
        ) {
            Log.d(TAG, "Incoming call $callId already ringing, enriching call info")
            voiceCallManager.handleIncomingCall(
                callId = callId,
                fromNumber = fromNumber,
                providerNumber = providerNumber,
                providerNumberLabel = providerNumberLabel
            )
            return
        }

        // Requirement 7.8: If call state is not IDLE, ignore the incoming call notification
        if (currentCallState.status != CallStatus.IDLE) {
            Log.d(TAG, "Incoming call $callId ignored: call state is ${currentCallState.status}, not IDLE")
            return
        }

        // Requirement 7.1: Forward to VoiceCallManager to transition state to RINGING
        voiceCallManager.handleIncomingCall(
            callId = callId,
            fromNumber = fromNumber,
            providerNumber = providerNumber,
            providerNumberLabel = providerNumberLabel
        )

        val contactName = payload.contactName
            ?: contactResolver.resolveContactName(fromNumber)

        val displayName = contactName ?: fromNumber
        val providerLabel = payload.providerNumberLabel ?: payload.providerNumber ?: ""

        val androidNotificationId = CALL_NOTIFICATION_ID_BASE + (++callNotificationCounter % 100)

        // Full-screen intent: launch IncomingCallActivity over lock screen
        val fullScreenIntent = app.svarla.IncomingCallActivity.createIntent(context, callId, fromNumber)
        val fullScreenPendingIntent = PendingIntent.getActivity(
            context,
            androidNotificationId,
            fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Answer action intent
        val answerIntent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_ANSWER_CALL
            putExtra(EXTRA_CALL_ID, callId)
            putExtra(EXTRA_NOTIFICATION_ID, androidNotificationId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val answerPendingIntent = PendingIntent.getActivity(
            context,
            androidNotificationId + 1000,
            answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Decline action intent — uses BroadcastReceiver to avoid opening the app
        val declineIntent = Intent(context, CallActionReceiver::class.java).apply {
            action = CallActionReceiver.ACTION_DECLINE
            putExtra(EXTRA_CALL_ID, callId)
        }
        val declinePendingIntent = PendingIntent.getBroadcast(
            context,
            androidNotificationId + 2000,
            declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val contentText = if (providerLabel.isNotEmpty()) {
            "Incoming call on $providerLabel"
        } else {
            "Incoming call"
        }

        val caller = androidx.core.app.Person.Builder()
            .setName(displayName)
            .setImportant(true)
            .build()

        val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(displayName)
            .setContentText(contentText)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setSilent(true) // Sound/vibration handled by foreground service notification + IncomingCallRinger
            .setContentIntent(fullScreenPendingIntent)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    caller,
                    declinePendingIntent,
                    answerPendingIntent
                )
            )
            .build()

        showNotification(payload.id, androidNotificationId, notification)
        Log.d(TAG, "Showing incoming call notification: $callId from $displayName")
    }

    // ========================================================================
    // SMS Notification
    // ========================================================================

    /**
     * Shows an SMS notification with sender info and message preview.
     * Default priority, standard notification sound.
     */
    private fun handleSmsNotification(payload: PushNotificationPayload) {
        val fromNumber = payload.from ?: "Unknown"
        val messagePreview = payload.messagePreview ?: "New message"

        val contactName = payload.contactName
            ?: contactResolver.resolveContactName(fromNumber)

        val displayName = contactName ?: fromNumber
        val providerLabel = payload.providerNumberLabel ?: ""

        val androidNotificationId = SMS_NOTIFICATION_ID_BASE + (++smsNotificationCounter % 500)

        val tapIntent = createTapIntent(
            notificationType = TYPE_INCOMING_SMS,
            phoneNumber = fromNumber,
            providerNumber = payload.providerNumber,
            notificationId = androidNotificationId
        )

        val title = if (providerLabel.isNotEmpty()) {
            "$displayName → $providerLabel"
        } else {
            displayName
        }

        val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(messagePreview)
            .setStyle(NotificationCompat.BigTextStyle().bigText(messagePreview))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(tapIntent)
            .build()

        showNotification(payload.id, androidNotificationId, notification)
        Log.d(TAG, "Showing SMS notification from $displayName")
    }

    // ========================================================================
    // Missed Call Notification
    // ========================================================================

    /**
     * Shows a missed call notification with caller info and time.
     * Default priority.
     *
     * If the call is still in RINGING state (e.g., the WebSocket disconnect event
     * was lost due to delayed connection), this also triggers the call to end
     * via VoiceCallManager.handleCallCancelled().
     */
    private fun handleMissedCallNotification(payload: PushNotificationPayload) {
        val fromNumber = payload.from ?: "Unknown"
        val callId = payload.callId

        // If the user explicitly declined this call, suppress the missed call notification.
        // A declined call is not a missed call — the user intentionally rejected it.
        // NOTE: The server should mark the notification as read when processing the decline,
        // but this guard handles race conditions where the missed_call event arrives first.
        if (callId != null && voiceCallManager.wasCallDeclined(callId)) {
            Log.d(TAG, "Suppressing missed call notification for declined call: $callId")
            return
        }
        if (callId == null && fromNumber != "Unknown" && voiceCallManager.wasRecentCallDeclinedFrom(fromNumber)) {
            Log.d(TAG, "Suppressing missed call notification for recently declined number: $fromNumber")
            return
        }

        // If this call is still actively ringing, cancel it immediately.
        // This handles the case where the WebSocket wasn't connected when the caller hung up,
        // and the missed_call push arrives before the 45s inbound timeout.
        val currentCallState = voiceCallManager.callState.value
        if (callId != null &&
            currentCallState.status == CallStatus.RINGING &&
            currentCallState.activeCallInfo?.callId == callId
        ) {
            Log.d(TAG, "Missed call push received while still RINGING for $callId — cancelling")
            voiceCallManager.handleCallCancelled(callId, "caller_disconnect")
            // The missed call notification and history entry will be handled by
            // VoiceCallManager.endCallInternal() via the MissedCallNotifier, so return early
            // to avoid showing a duplicate notification.
            return
        }

        val contactName = payload.contactName
            ?: contactResolver.resolveContactName(fromNumber)

        val displayName = contactName ?: fromNumber
        val providerLabel = payload.providerNumberLabel ?: ""

        val androidNotificationId = MISSED_CALL_NOTIFICATION_ID_BASE + (++missedCallNotificationCounter % 500)

        val tapIntent = createTapIntent(
            notificationType = TYPE_MISSED_CALL,
            phoneNumber = fromNumber,
            notificationId = androidNotificationId
        )

        val callTime = payload.timestamp?.let { ts ->
            // Handle both epoch seconds and epoch milliseconds from server
            val epochMillis = if (ts < 10_000_000_000L) ts * 1000L else ts
            val sdf = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
            sdf.timeZone = java.util.TimeZone.getDefault()
            sdf.format(java.util.Date(epochMillis))
        } ?: ""

        val contentText = buildString {
            append("Missed call")
            if (providerLabel.isNotEmpty()) append(" on $providerLabel")
            else {
                val providerNumber = payload.providerNumber ?: payload.to ?: ""
                if (providerNumber.isNotEmpty()) append(" to $providerNumber")
            }
            if (callTime.isNotEmpty()) append(" at $callTime")
        }

        val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_MISSED_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(displayName)
            .setContentText(contentText)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setAutoCancel(true)
            .setContentIntent(tapIntent)
            .setGroup(GROUP_MISSED_CALLS)
            .build()

        showNotification(payload.id, androidNotificationId, notification)
        Log.d(TAG, "Showing missed call notification from $displayName")
    }

    /**
     * Handle a blocked call push notification.
     * Shows a low-priority notification indicating a call was blocked.
     * Shows the caller number and the provider number/label that was called.
     */
    private fun handleBlockedCallNotification(payload: PushNotificationPayload) {
        val fromNumber = payload.from ?: "Unknown"
        val contactName = payload.contactName
            ?: contactResolver.resolveContactName(fromNumber)
        val displayName = contactName ?: fromNumber
        val providerLabel = payload.providerNumberLabel ?: ""
        val providerNumber = payload.providerNumber ?: payload.to ?: ""

        val androidNotificationId = MISSED_CALL_NOTIFICATION_ID_BASE + (++missedCallNotificationCounter % 500)

        val tapIntent = createTapIntent(
            notificationType = TYPE_BLOCKED_CALL,
            phoneNumber = fromNumber,
            notificationId = androidNotificationId
        )

        val contentText = buildString {
            append("Blocked call")
            if (providerLabel.isNotEmpty()) {
                append(" on $providerLabel")
            } else if (providerNumber.isNotEmpty()) {
                append(" to $providerNumber")
            }
        }

        val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_MISSED_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(displayName)
            .setContentText(contentText)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setAutoCancel(true)
            .setContentIntent(tapIntent)
            .setGroup(GROUP_MISSED_CALLS)
            .build()

        showNotification(payload.id, androidNotificationId, notification)
        Log.d(TAG, "Showing blocked call notification from $displayName")
    }

    // ========================================================================
    // New Device Login Notification
    // ========================================================================

    /**
     * Handle a new device login push notification.
     * Delegates to NewDeviceLoginNotifier which shows a persistent notification.
     * The notification is not auto-dismissed — user must tap or swipe it away.
     */
    private fun handleNewDeviceLoginNotification(payload: PushNotificationPayload) {
        val deviceName = payload.from ?: "Unknown device"
        val deviceId = payload.id

        newDeviceLoginNotifier.showNewDeviceLoginNotification(deviceId, deviceName)
        Log.d(TAG, "New device login notification delegated for: $deviceName")
    }

    // ========================================================================
    // Notification Dismissal
    // ========================================================================

    /**
     * Dismiss the notification for a specific call (e.g., when user answers/declines
     * or opens the call screen directly).
     */
    fun dismissCallNotification(callId: String) {
        // Find and cancel any notification with this callId
        val iterator = serverNotificationIdMap.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (entry.key.contains(callId) || entry.key.startsWith("call_")) {
                notificationManager.cancel(entry.value)
                iterator.remove()
            }
        }
    }

    /**
     * Dismiss all missed call and blocked call notifications.
     * Called when the user opens the Call History screen.
     * Covers both notifications posted by this handler AND by MissedCallNotifier.
     * Uses the system NotificationManager to find active notifications in the missed call range,
     * ensuring dismissal works even after app restart.
     */
    fun dismissAllMissedCallNotifications() {
        // Dismiss any tracked notifications in the missed call range
        val iterator = serverNotificationIdMap.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (entry.value in MISSED_CALL_NOTIFICATION_ID_BASE..(MISSED_CALL_NOTIFICATION_ID_BASE + 500)) {
                notificationManager.cancel(entry.value)
                iterator.remove()
            }
        }
        // Dismiss notifications posted by MissedCallNotifier (ID range 3500+)
        missedCallNotifier.dismissAll()

        // Fallback: cancel ALL active notifications in the missed call channel.
        // This handles the case where the app was restarted and in-memory tracking is lost.
        try {
            val nm = context.getSystemService(android.app.NotificationManager::class.java)
            nm?.activeNotifications?.forEach { sbn ->
                if (sbn.notification.channelId == NotificationChannels.CHANNEL_ID_MISSED_CALLS) {
                    nm.cancel(sbn.id)
                }
            }
        } catch (_: Exception) {}
    }

    /**
     * Dismiss notifications related to a specific phone number's conversation.
     * Called when the user opens the conversation thread.
     */
    fun dismissConversationNotifications(phoneNumber: String) {
        val targetKey = numberMatchKey(phoneNumber)

        // 1) In-memory pass: find SMS notifications matching this phone number
        //    via the cached payload.
        val toRemove = mutableListOf<String>()
        for ((serverNotificationId, cachedEvent) in serverNotificationPayloadCache) {
            val type = serverNotificationTypeMap[serverNotificationId]
            if (type != TYPE_INCOMING_SMS) continue

            val senderNumber = extractPayloadField(cachedEvent, "senderNumber") ?: continue
            if (numberMatchKey(senderNumber) == targetKey) {
                toRemove.add(serverNotificationId)
            }
        }

        for (serverNotificationId in toRemove) {
            val androidId = serverNotificationIdMap[serverNotificationId] ?: continue
            cancelAndMarkRead(serverNotificationId, androidId)
        }

        // 2) Persisted pass + activeNotifications fallback (survives process death).
        //    If the app was restarted, the in-memory maps are empty, so use the
        //    Room-backed records to locate the Android notification ids for this
        //    conversation, and cancel any lingering message-channel notifications.
        scope.launch(Dispatchers.IO) {
            try {
                val persisted = activeNotificationDao.getByType(TYPE_INCOMING_SMS)
                    .filter { it.normalizedNumber != null && it.normalizedNumber == targetKey }
                for (record in persisted) {
                    withContext(Dispatchers.Main) {
                        cancelAndMarkRead(record.serverId, record.androidId)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to query persisted notifications for dismissal", e)
            }

            // Last-resort fallback: cancel active notifications on the messages
            // channel that we can't otherwise attribute (e.g. posted by a prior
            // process with no persisted record). Mirrors the missed-call path.
            try {
                val nm = context.getSystemService(android.app.NotificationManager::class.java)
                val persistedAndroidIds = activeNotificationDao.getAll()
                    .filter { it.normalizedNumber == targetKey }
                    .map { it.androidId }
                    .toSet()
                withContext(Dispatchers.Main) {
                    nm?.activeNotifications?.forEach { sbn ->
                        if (sbn.notification.channelId == NotificationChannels.CHANNEL_ID_MESSAGES &&
                            sbn.id in persistedAndroidIds
                        ) {
                            nm.cancel(sbn.id)
                        }
                    }
                }
            } catch (_: Exception) {}
        }
    }

    /**
     * Cancel the Android notification, untrack it, and mark it read on the server
     * so it doesn't reappear on the next pending-notification fetch.
     */
    private fun cancelAndMarkRead(serverNotificationId: String, androidId: Int) {
        notificationManager.cancel(androidId)
        untrackServerNotification(serverNotificationId)
        val intent = Intent(context, NotificationDismissReceiver::class.java).apply {
            action = NotificationDismissReceiver.ACTION_DISMISS
            putExtra(NotificationDismissReceiver.EXTRA_SERVER_NOTIFICATION_ID, serverNotificationId)
        }
        context.sendBroadcast(intent)
    }

    /**
     * Dismiss all missed call notifications.
     * Called when the user opens the call history screen.
     */
    fun dismissMissedCallNotifications() {
        val iterator = serverNotificationIdMap.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (entry.key.startsWith("missed_")) {
                notificationManager.cancel(entry.value)
                iterator.remove()
            }
        }
    }

    /**
     * Cancel all notifications from this app.
     */
    fun cancelAll() {
        notificationManager.cancelAll()
        serverNotificationIdMap.clear()
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Creates a PendingIntent for notification tap actions that opens the
     * appropriate screen in the app.
     */
    private fun createTapIntent(
        notificationType: String,
        callId: String? = null,
        phoneNumber: String? = null,
        providerNumber: String? = null,
        notificationId: Int
    ): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra(EXTRA_NOTIFICATION_TYPE, notificationType)
            callId?.let { putExtra(EXTRA_CALL_ID, it) }
            phoneNumber?.let { putExtra(EXTRA_PHONE_NUMBER, it) }
            providerNumber?.let { putExtra(EXTRA_PROVIDER_NUMBER, it) }
            putExtra(EXTRA_NOTIFICATION_ID, notificationId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        return PendingIntent.getActivity(
            context,
            notificationId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /**
     * Creates a [PendingIntent] that fires when the user swipes away a notification.
     * The intent triggers [NotificationDismissReceiver] which marks the notification
     * as read on the server, preventing it from reappearing on next fetch.
     */
    private fun createDismissIntent(serverNotificationId: String, androidNotificationId: Int): PendingIntent {
        val intent = Intent(context, NotificationDismissReceiver::class.java).apply {
            action = NotificationDismissReceiver.ACTION_DISMISS
            putExtra(NotificationDismissReceiver.EXTRA_SERVER_NOTIFICATION_ID, serverNotificationId)
        }
        return PendingIntent.getBroadcast(
            context,
            androidNotificationId + 5000, // offset to avoid collision with other PendingIntents
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /**
     * Show a notification and track it in the server notification ID map for dismissal.
     */
    private fun showNotification(payloadId: String, androidId: Int, notification: Notification) {
        serverNotificationIdMap[payloadId] = androidId
        try {
            notificationManager.notify(androidId, notification)
        } catch (e: SecurityException) {
            Log.e(TAG, "Missing POST_NOTIFICATIONS permission", e)
        }
    }

    /**
     * Normalizes a phone number for comparison purposes.
     */
    private fun normalizePhoneNumber(number: String): String {
        return number.replace(Regex("[^+\\d]"), "")
    }

    /**
     * Produces a stable match key for comparing two phone numbers that may differ
     * in formatting (e.g. "+46701234567" vs "0701234567" vs "070-123 45 67").
     *
     * Strategy: strip to digits only, then use the last [NUMBER_MATCH_DIGITS]
     * significant digits. This tolerates country-code / leading-zero differences
     * between the pushed sender number and the locally stored conversation number,
     * which the previous exact-normalized comparison did not.
     */
    private fun numberMatchKey(number: String): String {
        val digits = number.filter { it.isDigit() }
        if (digits.isEmpty()) return normalizePhoneNumber(number)
        return if (digits.length <= NUMBER_MATCH_DIGITS) {
            digits
        } else {
            digits.takeLast(NUMBER_MATCH_DIGITS)
        }
    }
}
