package app.svarla.domain.notifications

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import app.svarla.MainActivity
import app.svarla.R
import app.svarla.data.remote.AuthManager
import app.svarla.data.remote.sync.SyncConnectionState
import app.svarla.data.remote.sync.SyncManager
import app.svarla.domain.call.VoiceCallManager
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Foreground service that keeps a persistent WebSocket connection alive for
 * real-time notification delivery when UnifiedPush is not available.
 *
 * Similar to Signal's approach for devices without FCM: the service holds a
 * partial wake lock and maintains the SyncManager WebSocket connection,
 * ensuring incoming calls and messages are delivered promptly even when the
 * device is in doze mode.
 *
 * Requires the user to exempt the app from battery optimization
 * (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) for reliable background operation.
 */
@AndroidEntryPoint
class PushWebSocketService : Service() {

    companion object {
        private const val TAG = "PushWsService"
        private const val NOTIFICATION_ID = 800
        private const val WAKELOCK_TAG = "svarla:push_websocket"
        private const val RESTART_REQUEST_CODE = 801
        private const val RESTART_DELAY_MS = 1000L

        private const val ACTION_START = "app.svarla.action.PUSH_WS_START"
        private const val ACTION_STOP = "app.svarla.action.PUSH_WS_STOP"

        fun start(context: Context) {
            val intent = Intent(context, PushWebSocketService::class.java).apply {
                action = ACTION_START
            }
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, PushWebSocketService::class.java).apply {
                action = ACTION_STOP
            }
            context.startForegroundService(intent)
        }
    }

    @Inject lateinit var syncManager: SyncManager
    @Inject lateinit var authManager: AuthManager

    // Injected to ensure VoiceCallManager is instantiated and observing WebSocket
    // events (incoming calls) even when the app UI is not running.
    @Inject lateinit var voiceCallManager: VoiceCallManager

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var wakeLock: PowerManager.WakeLock? = null
    private var stateObserverJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                goForeground(buildNotification("Connecting…"))
                ensureWebSocketConnected()
                observeConnectionState()
            }
            ACTION_STOP -> {
                Log.d(TAG, "Stopping persistent WebSocket service")
                // Must call startForeground() before stopping, because the system
                // may have scheduled this service via startForegroundService() and
                // expects the foreground contract to be fulfilled even if we stop
                // immediately (e.g. teardownCurrentMode() queues STOP before START).
                goForeground(buildNotification("Disconnecting…"))
                stopSelf()
            }
            else -> {
                // Service restarted by system — reconnect
                goForeground(buildNotification("Reconnecting…"))
                ensureWebSocketConnected()
                observeConnectionState()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        stateObserverJob?.cancel()
        releaseWakeLock()
        serviceScope.cancel()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        Log.d(TAG, "Task removed (app swiped away), scheduling service restart")
        // The process will be killed shortly. Use AlarmManager to ensure the
        // service is restarted even if the system doesn't honor START_STICKY
        // quickly enough (common on OEM-skinned Android).
        scheduleRestart()
    }

    private fun scheduleRestart() {
        val restartIntent = Intent(this, PushWebSocketService::class.java).apply {
            action = ACTION_START
        }
        val pendingIntent = PendingIntent.getForegroundService(
            this,
            RESTART_REQUEST_CODE,
            restartIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val alarmManager = getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
        alarmManager.setAndAllowWhileIdle(
            android.app.AlarmManager.ELAPSED_REALTIME_WAKEUP,
            android.os.SystemClock.elapsedRealtime() + RESTART_DELAY_MS,
            pendingIntent
        )
    }

    private fun goForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun ensureWebSocketConnected() {
        if (authManager.hasValidSession()) {
            syncManager.connect()
        }
    }

    private fun observeConnectionState() {
        stateObserverJob?.cancel()
        stateObserverJob = serviceScope.launch {
            syncManager.connectionState.collectLatest { state ->
                val statusText = when (state) {
                    SyncConnectionState.CONNECTED -> "Connected"
                    SyncConnectionState.CONNECTING -> "Connecting…"
                    SyncConnectionState.RECONNECTING -> "Reconnecting…"
                    SyncConnectionState.POLLING_FALLBACK -> "Polling (WebSocket unavailable)"
                    SyncConnectionState.DISCONNECTED -> {
                        // Attempt reconnect if we still have a valid session
                        if (authManager.hasValidSession()) {
                            syncManager.connect()
                        }
                        "Disconnected"
                    }
                }
                updateNotification(buildNotification(statusText))
            }
        }
    }

    private fun updateNotification(notification: Notification) {
        val nm = getSystemService(android.app.NotificationManager::class.java)
        nm?.notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(statusText: String): Notification {
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val tapPendingIntent = PendingIntent.getActivity(
            this, NOTIFICATION_ID, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, NotificationChannels.CHANNEL_ID_CONNECTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Svarla")
            .setContentText(statusText)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(tapPendingIntent)
            .build()
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
            acquire()
        }
        Log.d(TAG, "Wake lock acquired")
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) {
                it.release()
                Log.d(TAG, "Wake lock released")
            }
        }
        wakeLock = null
    }
}
