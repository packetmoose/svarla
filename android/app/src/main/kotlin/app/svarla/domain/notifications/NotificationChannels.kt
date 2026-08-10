package app.svarla.domain.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat

/**
 * Defines and creates notification channels for the Svarla app.
 *
 * Channels:
 * - CALLS: High importance, heads-up, sound + vibration (ringtone)
 * - MESSAGES: Default importance for incoming SMS
 * - MISSED_CALLS: Default importance for missed call alerts
 */
object NotificationChannels {

    const val CHANNEL_ID_CALLS = "svarla_calls_v2"
    const val CHANNEL_ID_CALLS_LEGACY = "svarla_calls"
    const val CHANNEL_ID_MESSAGES = "svarla_messages"
    const val CHANNEL_ID_MISSED_CALLS = "svarla_missed_calls"
    const val CHANNEL_ID_DEVICE_LOGIN = "svarla_device_login"
    const val CHANNEL_ID_CONNECTION = "svarla_connection"

    /**
     * Creates all notification channels. Safe to call multiple times;
     * Android no-ops if channels already exist.
     */
    fun createAll(context: Context) {
        val manager = NotificationManagerCompat.from(context)

        val callChannel = NotificationChannel(
            CHANNEL_ID_CALLS,
            "Incoming Calls",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Notifications for incoming voice calls"
            // Sound and vibration are handled by IncomingCallRinger independently.
            // The channel is silent to avoid conflicts with the custom ringer
            // (Android's NotifAttentionHelper can mute "recently noisy" notifications,
            // which interrupts the continuous vibration pattern).
            enableVibration(false)
            setSound(null, null)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            setBypassDnd(true)
        }

        val messageChannel = NotificationChannel(
            CHANNEL_ID_MESSAGES,
            "Messages",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Notifications for incoming SMS messages"
            enableVibration(true)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
        }

        val missedCallChannel = NotificationChannel(
            CHANNEL_ID_MISSED_CALLS,
            "Missed Calls",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Notifications for missed voice calls"
            enableVibration(true)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
        }

        val deviceLoginChannel = NotificationChannel(
            CHANNEL_ID_DEVICE_LOGIN,
            "Device Login Alerts",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Alerts when a new device logs into your account"
            enableVibration(true)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
        }

        manager.createNotificationChannel(callChannel)
        manager.createNotificationChannel(messageChannel)
        manager.createNotificationChannel(missedCallChannel)
        manager.createNotificationChannel(deviceLoginChannel)

        // Delete the legacy call channel that had sound/vibration enabled
        // (conflicts with IncomingCallRinger's independent audio/vibration control)
        manager.deleteNotificationChannel(CHANNEL_ID_CALLS_LEGACY)

        val connectionChannel = NotificationChannel(
            CHANNEL_ID_CONNECTION,
            "Connection Service",
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = "Persistent notification for background connection (when UnifiedPush is unavailable)"
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        manager.createNotificationChannel(connectionChannel)
    }
}
