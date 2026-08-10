package app.svarla.domain.call

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import app.svarla.IncomingCallActivity
import app.svarla.MainActivity
import app.svarla.R
import app.svarla.domain.notifications.NotificationChannels
import app.svarla.domain.notifications.NotificationHandler
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Foreground service that keeps the process alive for the entire voice call lifecycle.
 *
 * This service is started whenever a call transitions away from IDLE (incoming RINGING,
 * outbound DIALING) and stopped when the call returns to IDLE. It provides:
 *
 * - Process protection: Android won't kill the app during an active call
 * - Full-screen intent support: Required on Android 10+ to show incoming call UI from background
 * - Persistent notification: Shows call state (ringing/dialing/connected) with duration timer
 * - Return-to-call: Tapping the notification opens the call screen
 * - In-notification actions: Answer/Decline for ringing, Hang Up for connected
 *
 * The service observes VoiceCallManager.callState and auto-updates the notification.
 * It auto-stops when the call ends (transitions to IDLE).
 *
 * Requirements: 7.1, 10.4, 10.5
 */
@AndroidEntryPoint
class CallForegroundService : Service() {

    companion object {
        private const val TAG = "CallFgService"
        private const val NOTIFICATION_ID = 900
        private const val INCOMING_CALL_NOTIFICATION_ID = 901

        private const val ACTION_START_RINGING = "app.svarla.action.CALL_SERVICE_RINGING"
        private const val ACTION_START_DIALING = "app.svarla.action.CALL_SERVICE_DIALING"
        private const val ACTION_UPDATE_CONNECTED = "app.svarla.action.CALL_SERVICE_CONNECTED"
        private const val ACTION_STOP = "app.svarla.action.CALL_SERVICE_STOP"

        private const val EXTRA_REMOTE_NUMBER = "remote_number"
        private const val EXTRA_CALL_ID = "call_id"
        private const val EXTRA_IS_INBOUND = "is_inbound"

        /**
         * Start the service for an incoming call (RINGING state).
         */
        fun startRinging(context: Context, callId: String, remoteNumber: String) {
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_START_RINGING
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_REMOTE_NUMBER, remoteNumber)
                putExtra(EXTRA_IS_INBOUND, true)
            }
            context.startForegroundService(intent)
        }

        /**
         * Start the service for an outbound call (DIALING state).
         */
        fun startDialing(context: Context, remoteNumber: String) {
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_START_DIALING
                putExtra(EXTRA_REMOTE_NUMBER, remoteNumber)
                putExtra(EXTRA_IS_INBOUND, false)
            }
            context.startForegroundService(intent)
        }

        /**
         * Update the service notification for CONNECTED state.
         */
        fun updateConnected(context: Context, remoteNumber: String) {
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_UPDATE_CONNECTED
                putExtra(EXTRA_REMOTE_NUMBER, remoteNumber)
            }
            context.startService(intent)
        }

        /**
         * Stop the service (call ended, back to IDLE).
         */
        fun stop(context: Context) {
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    @Inject
    lateinit var voiceCallManager: VoiceCallManager

    @Inject
    lateinit var incomingCallRinger: IncomingCallRinger

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var durationUpdateJob: Job? = null
    private var stateObserverJob: Job? = null

    private var currentRemoteNumber: String = ""
    private var currentCallId: String = ""
    private var connectedSinceMs: Long = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        observeCallState()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START_RINGING -> {
                currentRemoteNumber = intent.getStringExtra(EXTRA_REMOTE_NUMBER) ?: "Unknown"
                currentCallId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
                // Use a silent notification for the foreground service itself
                goForeground(buildSilentForegroundNotification(currentRemoteNumber))
                // Post a SEPARATE high-priority notification with fullScreenIntent
                // This is posted via NotificationManager.notify() which reliably triggers
                // the fullScreenIntent, unlike the foreground service notification.
                postIncomingCallNotification(currentRemoteNumber, currentCallId)
                incomingCallRinger.start()
            }
            ACTION_START_DIALING -> {
                currentRemoteNumber = intent.getStringExtra(EXTRA_REMOTE_NUMBER) ?: "Unknown"
                currentCallId = ""
                goForeground(buildDialingNotification(currentRemoteNumber))
            }
            ACTION_UPDATE_CONNECTED -> {
                currentRemoteNumber = intent.getStringExtra(EXTRA_REMOTE_NUMBER) ?: currentRemoteNumber
                connectedSinceMs = System.currentTimeMillis()
                incomingCallRinger.stop()
                cancelIncomingCallNotification()
                val connectedNotification = buildConnectedNotification(currentRemoteNumber, 0)
                upgradeForegroundForAudio(connectedNotification)
                updateNotification(connectedNotification)
                startDurationUpdates()
            }
            ACTION_STOP -> {
                Log.d(TAG, "Stopping call foreground service")
                incomingCallRinger.stop()
                cancelIncomingCallNotification()
                stopDurationUpdates()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            else -> {
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        incomingCallRinger.stop()
        stopDurationUpdates()
        stateObserverJob?.cancel()
    }

    // ========================================================================
    // Foreground management
    // ========================================================================

    private fun goForeground(notification: Notification) {
        Log.d(TAG, "Starting foreground service for call")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Start with phoneCall type only — microphone type requires RECORD_AUDIO
            // permission which may not be granted yet during the ringing phase.
            // The microphone type is added when the call connects via upgradeForegroundForAudio().
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /**
     * Upgrades the foreground service to include microphone type.
     * Called when the call is answered and audio is needed.
     * On Android 14+ this is required for mic access from a foreground service.
     * Requires RECORD_AUDIO permission to already be granted.
     */
    private fun upgradeForegroundForAudio(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                )
                Log.d(TAG, "Foreground service upgraded with microphone type")
            } catch (e: SecurityException) {
                // RECORD_AUDIO not granted — fall back to phoneCall only
                Log.e(TAG, "Cannot upgrade to microphone type: ${e.message}")
            }
        }
    }

    private fun updateNotification(notification: Notification) {
        val nm = getSystemService(android.app.NotificationManager::class.java)
        nm?.notify(NOTIFICATION_ID, notification)
    }

    // ========================================================================
    // Call state observation — auto-update notification & auto-stop
    // ========================================================================

    private fun observeCallState() {
        stateObserverJob = serviceScope.launch {
            voiceCallManager.callState.collect { state ->
                when (state.status) {
                    CallStatus.RINGING -> {
                        val info = state.activeCallInfo ?: return@collect
                        currentRemoteNumber = info.remoteNumber
                        currentCallId = info.callId
                    }
                    CallStatus.DIALING -> {
                        val info = state.activeCallInfo ?: return@collect
                        currentRemoteNumber = info.remoteNumber
                        updateNotification(buildDialingNotification(currentRemoteNumber))
                    }
                    CallStatus.CONNECTED -> {
                        val info = state.activeCallInfo ?: return@collect
                        currentRemoteNumber = info.remoteNumber
                        incomingCallRinger.stop()
                        cancelIncomingCallNotification()
                        if (connectedSinceMs == 0L) {
                            connectedSinceMs = info.connectedTime ?: System.currentTimeMillis()
                            val connectedNotification = buildConnectedNotification(currentRemoteNumber, 0)
                            upgradeForegroundForAudio(connectedNotification)
                            startDurationUpdates()
                        }
                    }
                    CallStatus.ENDED, CallStatus.IDLE -> {
                        // Call is over — stop the service
                        incomingCallRinger.stop()
                        cancelIncomingCallNotification()
                        stopDurationUpdates()
                        connectedSinceMs = 0L
                        stopForeground(STOP_FOREGROUND_REMOVE)
                        stopSelf()
                    }
                }
            }
        }
    }

    // ========================================================================
    // Duration timer for connected notification
    // ========================================================================

    private fun startDurationUpdates() {
        stopDurationUpdates()
        durationUpdateJob = serviceScope.launch {
            while (isActive) {
                val elapsed = if (connectedSinceMs > 0) {
                    ((System.currentTimeMillis() - connectedSinceMs) / 1000).toInt()
                } else 0
                updateNotification(buildConnectedNotification(currentRemoteNumber, elapsed))
                delay(1000)
            }
        }
    }

    private fun stopDurationUpdates() {
        durationUpdateJob?.cancel()
        durationUpdateJob = null
    }

    // ========================================================================
    // Notification builders
    // ========================================================================

    /**
     * Builds a minimal silent notification for the foreground service.
     * This keeps the service alive but doesn't produce sound/vibration.
     */
    private fun buildSilentForegroundNotification(remoteNumber: String): Notification {
        val tapPendingIntent = buildReturnToCallIntent()
        val displayNumber = remoteNumber.ifEmpty { "Unknown caller" }

        return NotificationCompat.Builder(this, NotificationChannels.CHANNEL_ID_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Incoming call")
            .setContentText(displayNumber)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(tapPendingIntent)
            .build()
    }

    /**
     * Posts a separate HIGH-priority notification with fullScreenIntent.
     *
     * This is posted via NotificationManager.notify() (not startForeground) because
     * fullScreenIntent is only reliably triggered on a freshly-posted alerting notification,
     * not on a foreground service notification.
     *
     * When the screen is off/locked: Android launches the fullScreenIntent (IncomingCallActivity)
     * When the screen is on: Android shows a heads-up notification with Answer/Decline buttons
     */
    private fun postIncomingCallNotification(remoteNumber: String, callId: String) {
        val displayNumber = remoteNumber.ifEmpty { "Unknown caller" }

        val fullScreenIntent = IncomingCallActivity.createIntent(this, callId, remoteNumber)
        val fullScreenPendingIntent = PendingIntent.getActivity(
            this, INCOMING_CALL_NOTIFICATION_ID, fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val answerIntent = Intent(this, MainActivity::class.java).apply {
            action = NotificationHandler.ACTION_ANSWER_CALL
            putExtra(NotificationHandler.EXTRA_CALL_ID, callId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val answerPendingIntent = PendingIntent.getActivity(
            this, INCOMING_CALL_NOTIFICATION_ID + 1, answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val declineIntent = Intent(this, CallActionReceiver::class.java).apply {
            action = CallActionReceiver.ACTION_DECLINE
            putExtra(NotificationHandler.EXTRA_CALL_ID, callId)
        }
        val declinePendingIntent = PendingIntent.getBroadcast(
            this, INCOMING_CALL_NOTIFICATION_ID + 2, declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val caller = androidx.core.app.Person.Builder()
            .setName(displayNumber)
            .setImportant(true)
            .build()

        val notification = NotificationCompat.Builder(this, NotificationChannels.CHANNEL_ID_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Incoming call")
            .setContentText(displayNumber)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setContentIntent(fullScreenPendingIntent)
            .setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    caller,
                    declinePendingIntent,
                    answerPendingIntent
                )
            )
            .build()

        val nm = getSystemService(android.app.NotificationManager::class.java)
        nm?.notify(INCOMING_CALL_NOTIFICATION_ID, notification)
        Log.d(TAG, "Posted incoming call notification with CallStyle")
    }

    /**
     * Cancels the separate incoming call notification (when call is answered/declined/ended).
     */
    private fun cancelIncomingCallNotification() {
        val nm = getSystemService(android.app.NotificationManager::class.java)
        nm?.cancel(INCOMING_CALL_NOTIFICATION_ID)
    }

    private fun buildRingingNotification(remoteNumber: String, callId: String): Notification {
        val displayNumber = remoteNumber.ifEmpty { "Unknown caller" }

        // Full-screen intent launches the dedicated IncomingCallActivity over the lock screen
        val fullScreenIntent = IncomingCallActivity.createIntent(this, callId, remoteNumber)
        val fullScreenPendingIntent = PendingIntent.getActivity(
            this, NOTIFICATION_ID, fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val answerIntent = Intent(this, MainActivity::class.java).apply {
            action = NotificationHandler.ACTION_ANSWER_CALL
            putExtra(NotificationHandler.EXTRA_CALL_ID, callId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val answerPendingIntent = PendingIntent.getActivity(
            this, NOTIFICATION_ID + 1, answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val declineIntent = Intent(this, CallActionReceiver::class.java).apply {
            action = CallActionReceiver.ACTION_DECLINE
            putExtra(NotificationHandler.EXTRA_CALL_ID, callId)
        }
        val declinePendingIntent = PendingIntent.getBroadcast(
            this, NOTIFICATION_ID + 2, declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val caller = androidx.core.app.Person.Builder()
            .setName(displayNumber)
            .setImportant(true)
            .build()

        return NotificationCompat.Builder(this, NotificationChannels.CHANNEL_ID_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Incoming call")
            .setContentText(displayNumber)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setContentIntent(fullScreenPendingIntent)
            .setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    caller,
                    declinePendingIntent,
                    answerPendingIntent
                )
            )
            .build()
    }

    private fun buildDialingNotification(remoteNumber: String): Notification {
        val tapPendingIntent = buildReturnToCallIntent()

        val hangUpPendingIntent = buildHangUpIntent()

        return NotificationCompat.Builder(this, NotificationChannels.CHANNEL_ID_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Calling...")
            .setContentText(remoteNumber)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setSilent(true)
            .setContentIntent(tapPendingIntent)
            .addAction(R.drawable.ic_notification, "Hang Up", hangUpPendingIntent)
            .build()
    }

    private fun buildConnectedNotification(remoteNumber: String, elapsedSeconds: Int): Notification {
        val tapPendingIntent = buildReturnToCallIntent()
        val hangUpPendingIntent = buildHangUpIntent()

        val durationText = formatDuration(elapsedSeconds)

        return NotificationCompat.Builder(this, NotificationChannels.CHANNEL_ID_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("On call · $durationText")
            .setContentText(remoteNumber)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setSilent(true)
            .setContentIntent(tapPendingIntent)
            .addAction(R.drawable.ic_notification, "Hang Up", hangUpPendingIntent)
            .build()
    }

    // ========================================================================
    // PendingIntent helpers
    // ========================================================================

    private fun buildReturnToCallIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            this, NOTIFICATION_ID, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildHangUpIntent(): PendingIntent {
        val intent = Intent(this, CallActionReceiver::class.java).apply {
            action = CallActionReceiver.ACTION_HANG_UP
        }
        return PendingIntent.getBroadcast(
            this, NOTIFICATION_ID + 3, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    // ========================================================================
    // Utility
    // ========================================================================

    private fun formatDuration(totalSeconds: Int): String {
        val hours = totalSeconds / 3600
        val minutes = (totalSeconds % 3600) / 60
        val seconds = totalSeconds % 60
        return if (hours > 0) {
            String.format("%d:%02d:%02d", hours, minutes, seconds)
        } else {
            String.format("%d:%02d", minutes, seconds)
        }
    }
}
