package app.svarla.domain.notifications

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.svarla.MainActivity
import app.svarla.R
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Shows a persistent (non-auto-dismiss) notification when a new device logs into the account.
 * The notification is only dismissed when the user taps it (navigating to settings/devices)
 * or explicitly swipes it away. Each device's notification is independent.
 */
@Singleton
class NewDeviceLoginNotifier @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "NewDeviceLoginNotifier"
        private const val NOTIFICATION_ID_BASE = 4000

        /** Intent extra to signal that the notification should navigate to the devices settings. */
        const val EXTRA_NAVIGATE_TO_DEVICES = "navigate_to_devices"
    }

    private var counter = 0

    /**
     * Show a persistent notification indicating a new device has logged in.
     *
     * @param deviceId The ID of the newly logged-in device
     * @param deviceName The name of the newly logged-in device
     */
    fun showNewDeviceLoginNotification(deviceId: String, deviceName: String) {
        val androidNotificationId = NOTIFICATION_ID_BASE + (++counter % 100)

        val tapIntent = Intent(context, MainActivity::class.java).apply {
            putExtra(NotificationHandler.EXTRA_NOTIFICATION_TYPE, "new_device_login")
            putExtra(EXTRA_NAVIGATE_TO_DEVICES, true)
            putExtra(NotificationHandler.EXTRA_NOTIFICATION_ID, androidNotificationId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        val tapPendingIntent = PendingIntent.getActivity(
            context,
            androidNotificationId,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_DEVICE_LOGIN)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("New device logged in")
            .setContentText("$deviceName was added to your account")
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText("$deviceName was added to your account. Tap to view registered devices.")
            )
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_SYSTEM)
            .setAutoCancel(true) // Dismiss when tapped
            .setOngoing(false) // Allow swipe-to-dismiss but don't auto-timeout
            .setContentIntent(tapPendingIntent)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(androidNotificationId, notification)
            Log.d(TAG, "Showing new device login notification: $deviceName (id=$deviceId)")
        } catch (e: SecurityException) {
            Log.e(TAG, "Missing POST_NOTIFICATIONS permission", e)
        }
    }
}
