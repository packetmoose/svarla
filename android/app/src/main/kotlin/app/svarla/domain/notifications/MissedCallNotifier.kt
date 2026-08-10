package app.svarla.domain.notifications

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.svarla.MainActivity
import app.svarla.R
import app.svarla.domain.contacts.ContactResolver
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Responsible for showing missed call notifications.
 *
 * Separated from [NotificationHandler] to avoid a circular dependency with [VoiceCallManager].
 * VoiceCallManager calls this directly when an inbound call ends without being answered.
 */
@Singleton
class MissedCallNotifier @Inject constructor(
    @ApplicationContext private val context: Context,
    private val contactResolver: ContactResolver
) {
    companion object {
        private const val TAG = "MissedCallNotifier"
        private const val MISSED_CALL_NOTIFICATION_ID_BASE = 3500
        private const val MAX_TRACKED_CALL_IDS = 50
    }

    private var counter = 0

    /** Tracks call IDs for which we've already shown a missed call notification. */
    private val notifiedCallIds = ConcurrentHashMap.newKeySet<String>()

    /** Tracks Android notification IDs we've posted so they can be dismissed later. */
    private val activeNotificationIds = ConcurrentHashMap.newKeySet<Int>()

    /** Tracks recently notified caller numbers with their timestamp for dedup by number. */
    private val recentlyNotifiedCallers = ConcurrentHashMap<String, Long>()

    /**
     * Returns true if a missed call notification was already shown for this call ID.
     */
    fun wasAlreadyNotified(callId: String): Boolean {
        return notifiedCallIds.contains(callId)
    }

    /**
     * Returns true if a missed call notification was recently shown for this caller number
     * (within the last 30 seconds). Used to suppress duplicate push notifications.
     */
    fun wasRecentlyNotifiedForCaller(callerNumber: String): Boolean {
        val lastTime = recentlyNotifiedCallers[callerNumber] ?: return false
        return (System.currentTimeMillis() - lastTime) < 30_000L
    }

    /**
     * Posts a missed call notification for the given caller.
     *
     * @param callId The call ID (used for deduplication-friendly notification ID)
     * @param callerNumber The remote party's phone number (E.164)
     * @param providerNumberLabel Optional label for the provider number the call came in on
     * @param timestamp When the call was received (epoch millis)
     */
    fun showMissedCallNotification(
        callId: String,
        callerNumber: String,
        providerNumberLabel: String?,
        timestamp: Long
    ) {
        val contactName = contactResolver.resolveContactName(callerNumber)
        val displayName = contactName ?: callerNumber.ifEmpty { "Unknown" }

        val androidNotificationId = MISSED_CALL_NOTIFICATION_ID_BASE + (++counter % 500)

        val tapIntent = Intent(context, MainActivity::class.java).apply {
            putExtra(NotificationHandler.EXTRA_NOTIFICATION_TYPE, NotificationHandler.TYPE_MISSED_CALL)
            putExtra(NotificationHandler.EXTRA_PHONE_NUMBER, callerNumber)
            putExtra(NotificationHandler.EXTRA_NOTIFICATION_ID, androidNotificationId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        val tapPendingIntent = PendingIntent.getActivity(
            context,
            androidNotificationId,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val callTime = try {
            // Handle both epoch seconds and epoch milliseconds
            val epochMillis = if (timestamp < 10_000_000_000L) timestamp * 1000L else timestamp
            val sdf = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
            sdf.timeZone = java.util.TimeZone.getDefault()
            sdf.format(java.util.Date(epochMillis))
        } catch (_: Exception) { "" }

        val contentText = buildString {
            append("Missed call")
            if (!providerNumberLabel.isNullOrEmpty()) append(" on $providerNumberLabel")
            if (callTime.isNotEmpty()) append(" at $callTime")
        }

        val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_MISSED_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(displayName)
            .setContentText(contentText)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setAutoCancel(true)
            .setContentIntent(tapPendingIntent)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(androidNotificationId, notification)
            notifiedCallIds.add(callId)
            activeNotificationIds.add(androidNotificationId)
            recentlyNotifiedCallers[callerNumber] = System.currentTimeMillis()
            // Evict oldest entries if we exceed the cap
            if (notifiedCallIds.size > MAX_TRACKED_CALL_IDS) {
                notifiedCallIds.iterator().let { iter ->
                    if (iter.hasNext()) { iter.next(); iter.remove() }
                }
            }
            Log.d(TAG, "Showing missed call notification from $displayName (callId=$callId)")
        } catch (e: SecurityException) {
            Log.e(TAG, "Missing POST_NOTIFICATIONS permission", e)
        }
    }

    /**
     * Dismiss all missed call notifications posted by this notifier.
     * Called when the user opens the Call History screen.
     */
    fun dismissAll() {
        val notificationManager = NotificationManagerCompat.from(context)
        activeNotificationIds.forEach { id ->
            notificationManager.cancel(id)
        }
        activeNotificationIds.clear()
        Log.d(TAG, "Dismissed all missed call notifications")
    }
}
