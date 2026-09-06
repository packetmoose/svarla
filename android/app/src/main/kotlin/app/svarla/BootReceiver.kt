package app.svarla

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import app.svarla.data.remote.AuthManager
import app.svarla.domain.notifications.NotificationDeliveryMode
import app.svarla.domain.notifications.NotificationDeliveryPreferences
import app.svarla.domain.notifications.PushWebSocketService
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * Receives BOOT_COMPLETED and QUICKBOOT_POWERON broadcasts to restart the
 * persistent WebSocket notification service after device reboot.
 *
 * Without this, the app won't receive incoming call or message notifications
 * until the user manually opens it after a reboot.
 *
 * The receiver checks:
 * 1. The user is authenticated (has a valid session)
 * 2. The notification delivery mode is WEBSOCKET (not UnifiedPush, which
 *    is handled by the UnifiedPush distributor's own boot receiver)
 *
 * If both conditions are met, it starts PushWebSocketService as a foreground
 * service. The Application class lifecycle will handle the rest (SyncManager
 * connection, push endpoint setup, etc.) since starting the service also
 * triggers Application.onCreate().
 */
@AndroidEntryPoint
class BootReceiver : BroadcastReceiver() {

    @Inject lateinit var authManager: AuthManager
    @Inject lateinit var deliveryPreferences: NotificationDeliveryPreferences

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != "android.intent.action.QUICKBOOT_POWERON" &&
            action != "com.htc.intent.action.QUICKBOOT_POWERON"
        ) {
            return
        }

        Log.d(TAG, "Boot completed — checking if WebSocket service should start")

        if (!authManager.hasValidSession()) {
            Log.d(TAG, "No valid session — skipping service start")
            return
        }

        val mode = deliveryPreferences.getStoredMode()
        if (mode == NotificationDeliveryMode.WEBSOCKET) {
            Log.i(TAG, "Starting PushWebSocketService after boot")
            try {
                PushWebSocketService.start(context)
            } catch (e: Exception) {
                // On Android 12+ (enforced on 14/15), starting a dataSync foreground
                // service from a BOOT_COMPLETED receiver is disallowed and throws
                // ForegroundServiceStartNotAllowedException (a subclass of
                // IllegalStateException). Swallow it so the boot broadcast doesn't
                // crash the freshly-started process. The service will be started
                // normally when the user next opens the app (MainActivity ->
                // Application auth coroutine connects SyncManager directly).
                Log.w(TAG, "Cannot start PushWebSocketService from boot: ${e.message}")
            }
        } else {
            Log.d(TAG, "Notification mode is $mode — UnifiedPush distributor handles delivery")
        }
    }

    companion object {
        private const val TAG = "BootReceiver"
    }
}
