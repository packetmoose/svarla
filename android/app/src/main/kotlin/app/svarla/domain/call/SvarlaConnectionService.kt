package app.svarla.domain.call

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import app.svarla.IncomingCallActivity
import app.svarla.MainActivity
import app.svarla.R
import app.svarla.SvarlaApplication
import app.svarla.domain.notifications.NotificationChannels
import app.svarla.domain.notifications.NotificationHandler
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * Android ConnectionService subclass bound by TelecomManager for the Telecom_Path.
 *
 * Creates [SvarlaConnection] instances for incoming and outgoing calls.
 * On creation failure, falls back to the Legacy_Path via [CallServiceController].
 *
 * Uses `@AndroidEntryPoint` for Hilt dependency injection of [VoiceCallManager]
 * and [CallServiceController].
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 4.2, 4.4
 */
@AndroidEntryPoint
class SvarlaConnectionService : ConnectionService() {

    @Inject lateinit var voiceCallManager: VoiceCallManager
    @Inject lateinit var callServiceController: CallServiceController

    /**
     * Called by TelecomManager when an incoming call is ready to be created.
     * Creates a [SvarlaConnection] in STATE_RINGING with the caller's address set,
     * transitions [VoiceCallManager] to RINGING state (preventing duplicate call handling),
     * then posts an incoming call notification with fullScreenIntent and CallStyle.
     * Registers the connection with [CallServiceController] for bidirectional state sync.
     *
     * Requirements: 2.2, 3.1, 3.2, 4.2, 4.4, 9.1, 9.2
     */
    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val callId = extras.getString(EXTRA_CALL_ID) ?: ""
        val callerNumber = extras.getString(EXTRA_CALLER_NUMBER) ?: ""

        val connection = SvarlaConnection(voiceCallManager, callId).apply {
            setInitializing()
            connectionProperties = Connection.PROPERTY_SELF_MANAGED
            setCallerDisplayName(callerNumber, TelecomManager.PRESENTATION_ALLOWED)
            setAddress(
                Uri.fromParts(PhoneAccount.SCHEME_TEL, callerNumber, null),
                TelecomManager.PRESENTATION_ALLOWED
            )
            setRinging()
        }

        // Register active connection for App → Framework state sync
        callServiceController.setActiveConnection(connection)

        // Start observing VoiceCallManager state for defensive cleanup.
        // If the call was already ended (race condition where push/WebSocket event
        // triggered endCallInternal before the connection was created), or if it ends
        // later and notifyCallEnded doesn't reach this connection for any reason,
        // the connection will auto-disconnect itself.
        connection.observeCallState(
            kotlinx.coroutines.CoroutineScope(
                kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main
            )
        )

        // Transition VoiceCallManager to RINGING so downstream handlers (NotificationHandler,
        // WebSocket events) see the correct state and don't attempt duplicate Telecom routing.
        voiceCallManager.handleIncomingCallFromTelecom(callId, callerNumber)

        // Post incoming call notification with fullScreenIntent + CallStyle
        launchIncomingCallActivity(callId, callerNumber)

        return connection
    }

    /**
     * Called by TelecomManager when an outgoing call is ready to be created.
     * Creates a [SvarlaConnection] in STATE_DIALING with the destination address set.
     * Registers the connection with [CallServiceController] for bidirectional state sync.
     *
     * Requirements: 2.3, 3.1, 3.6, 9.1, 9.2
     */
    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val callId = extras.getString(EXTRA_CALL_ID) ?: ""

        val connection = SvarlaConnection(voiceCallManager, callId).apply {
            connectionProperties = Connection.PROPERTY_SELF_MANAGED
            setAddress(request?.address, TelecomManager.PRESENTATION_ALLOWED)
            setDialing()
        }

        // Register active connection for App → Framework state sync
        callServiceController.setActiveConnection(connection)

        // Defensive cleanup: auto-disconnect if VoiceCallManager ends the call
        connection.observeCallState(
            kotlinx.coroutines.CoroutineScope(
                kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main
            )
        )

        return connection
    }

    /**
     * Called by TelecomManager when an incoming connection cannot be created.
     * Falls back to the Legacy_Path via [CallServiceController.startForIncomingCall].
     *
     * Requirements: 2.4, 4.5
     */
    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        val extras = request?.extras ?: Bundle()
        val callId = extras.getString(EXTRA_CALL_ID) ?: ""
        val callerNumber = extras.getString(EXTRA_CALLER_NUMBER) ?: ""
        // Fallback to legacy path
        callServiceController.startForIncomingCall(callId, callerNumber)
    }

    /**
     * Called by TelecomManager when an outgoing connection cannot be created.
     * Falls back to the Legacy_Path via [CallServiceController.startForOutboundCall].
     *
     * Requirements: 2.4
     */
    override fun onCreateOutgoingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        // Outgoing call already initiated via VoiceCallManager;
        // just let the existing foreground service handle it
        val remoteNumber = request?.address?.schemeSpecificPart ?: ""
        callServiceController.startForOutboundCall(remoteNumber)
    }

    private fun launchIncomingCallActivity(callId: String, callerNumber: String) {
        // Skip posting the notification if the app is already in the foreground —
        // the full-screen incoming call UI is shown directly by the navigation layer,
        // and the notification's heads-up banner would overlap the caller name.
        if (SvarlaApplication.isInForeground) {
            Log.d(TAG, "App is in foreground, skipping incoming call notification (Telecom_Path)")
            return
        }

        val displayNumber = callerNumber.ifEmpty { "Unknown caller" }

        // Post a high-priority notification with fullScreenIntent.
        // On the Telecom_Path we CANNOT use CallForegroundService because Android 14+ requires
        // the phoneCall FGS type to be validated against an active ConnectionService binding,
        // and the timing doesn't work (connection isn't fully registered yet when FGS starts).
        // Instead, we post the notification directly — the fullScreenIntent wakes the screen
        // when the device is locked, and shows a heads-up notification when the screen is on.
        val fullScreenIntent = IncomingCallActivity.createIntent(this, callId, callerNumber)
        val fullScreenPendingIntent = PendingIntent.getActivity(
            this, TELECOM_CALL_NOTIFICATION_ID, fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val answerIntent = Intent(this, MainActivity::class.java).apply {
            action = NotificationHandler.ACTION_ANSWER_CALL
            putExtra(NotificationHandler.EXTRA_CALL_ID, callId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val answerPendingIntent = PendingIntent.getActivity(
            this, TELECOM_CALL_NOTIFICATION_ID + 1, answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val declineIntent = Intent(this, CallActionReceiver::class.java).apply {
            action = CallActionReceiver.ACTION_DECLINE
            putExtra(NotificationHandler.EXTRA_CALL_ID, callId)
        }
        val declinePendingIntent = PendingIntent.getBroadcast(
            this, TELECOM_CALL_NOTIFICATION_ID + 2, declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val caller = Person.Builder()
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

        val nm = getSystemService(NotificationManager::class.java)
        nm?.notify(TELECOM_CALL_NOTIFICATION_ID, notification)
        Log.d(TAG, "Posted incoming call notification with CallStyle (Telecom_Path)")
    }

    companion object {
        private const val TAG = "SvarlaConnService"
        /** Notification ID for the incoming call notification posted on the Telecom_Path. */
        const val TELECOM_CALL_NOTIFICATION_ID = 902
        /** Extra key for the backend call identifier passed via ConnectionRequest extras. */
        const val EXTRA_CALL_ID = "telecom_call_id"
        /** Extra key for the remote party number (E.164) passed via ConnectionRequest extras. */
        const val EXTRA_CALLER_NUMBER = "telecom_caller_number"
    }
}
