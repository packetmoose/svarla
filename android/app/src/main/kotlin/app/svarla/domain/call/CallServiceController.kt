package app.svarla.domain.call

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.TelecomManager
import android.util.Log
import androidx.core.app.NotificationCompat
import app.svarla.IncomingCallActivity
import app.svarla.MainActivity
import app.svarla.R
import app.svarla.domain.notifications.NotificationChannels
import app.svarla.domain.notifications.NotificationHandler
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Abstraction for controlling the call foreground service from VoiceCallManager.
 *
 * VoiceCallManager is a pure Kotlin singleton that shouldn't hold an Android Context directly.
 * This controller bridges the gap, allowing VoiceCallManager to start/update/stop the
 * foreground service without depending on Context itself.
 *
 * Extended with Telecom_Path routing: when PhoneAccount is registered, calls are routed
 * through TelecomManager. On failure or when not registered, falls back to Legacy_Path.
 */
interface CallServiceController {
    fun startForIncomingCall(callId: String, remoteNumber: String)
    fun startForOutboundCall(remoteNumber: String)
    fun updateConnected(remoteNumber: String)
    fun stop()
    /** Route an incoming call through TelecomManager (Telecom_Path), falling back to Legacy_Path on failure. */
    fun handleIncomingCallViaTelecom(callId: String, remoteNumber: String)
    /** Route an outgoing call through TelecomManager (Telecom_Path), falling back to Legacy_Path on failure. */
    fun handleOutgoingCallViaTelecom(destinationNumber: String)

    // ====== State Synchronization (App → Framework) ======

    /** Store the active [SvarlaConnection] reference for state sync propagation. */
    fun setActiveConnection(connection: SvarlaConnection?)

    /** Returns true if a Telecom_Path connection is currently active. */
    val isTelecomPathActive: Boolean

    /**
     * Notify that VoiceCallManager transitioned to CONNECTED.
     * Propagates to the active [SvarlaConnection] via [SvarlaConnection.onCallConnected].
     *
     * Requirements: 9.1
     */
    fun notifyCallConnected()

    /**
     * Notify that VoiceCallManager transitioned to ENDED.
     * Propagates to the active [SvarlaConnection] via [SvarlaConnection.onCallEnded].
     * Maps [CallEndReason] to the appropriate [android.telecom.DisconnectCause].
     *
     * Requirements: 9.2
     */
    fun notifyCallEnded(reason: CallEndReason)
}

/**
 * Default implementation backed by CallForegroundService (Legacy_Path) and TelecomManager (Telecom_Path).
 *
 * Routes calls through TelecomManager when PhoneAccount registration is successful.
 * Falls back to Legacy_Path (CallForegroundService) when registration has failed or
 * when a SecurityException occurs during the TelecomManager call.
 *
 * Tracks the active [SvarlaConnection] for bidirectional state synchronization:
 * - App → Framework: propagates VoiceCallManager CONNECTED/ENDED to the Connection.
 * - Framework → App: handled by [SvarlaConnection] callbacks directly.
 *
 * Requirements: 4.1, 4.5, 5.1, 7.1, 7.4, 9.1, 9.2
 */
@Singleton
class CallServiceControllerImpl @Inject constructor(
    @ApplicationContext private val context: Context,
    private val phoneAccountRegistrar: PhoneAccountRegistrar
) : CallServiceController {

    companion object {
        private const val TAG = "CallServiceController"
        /** Notification ID for the fallback incoming call notification (when FGS can't start). */
        private const val FALLBACK_NOTIFICATION_ID = 903

        /**
         * Maps [CallEndReason] to the appropriate [DisconnectCause] code for the Telecom framework.
         * Visible for testing.
         */
        internal fun toDisconnectCause(reason: CallEndReason): DisconnectCause {
            val causeCode = when (reason) {
                CallEndReason.LOCAL_HANGUP -> DisconnectCause.LOCAL
                CallEndReason.REMOTE_HANGUP -> DisconnectCause.REMOTE
                CallEndReason.FAILED -> DisconnectCause.ERROR
                CallEndReason.UNANSWERED -> DisconnectCause.MISSED
                CallEndReason.DECLINED -> DisconnectCause.REJECTED
                CallEndReason.ANSWERED_ELSEWHERE -> DisconnectCause.ANSWERED_ELSEWHERE
                CallEndReason.CONNECTIVITY_LOST -> DisconnectCause.ERROR
                CallEndReason.TIMEOUT -> DisconnectCause.MISSED
            }
            return DisconnectCause(causeCode)
        }
    }

    private val telecomManager: TelecomManager =
        context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager

    /** Active SvarlaConnection for bidirectional state sync. Null when on Legacy_Path. */
    private var activeConnection: SvarlaConnection? = null

    /** CallId for which an incoming Telecom connection has already been requested. */
    private var pendingIncomingCallId: String? = null

    override val isTelecomPathActive: Boolean
        get() = activeConnection != null || pendingIncomingCallId != null

    override fun setActiveConnection(connection: SvarlaConnection?) {
        activeConnection = connection
    }

    /**
     * Propagates VoiceCallManager CONNECTED state to the active [SvarlaConnection].
     * Transitions the Telecom framework connection to STATE_ACTIVE.
     * Dismisses the Telecom_Path incoming call notification.
     *
     * Requirements: 9.1
     */
    override fun notifyCallConnected() {
        activeConnection?.onCallConnected()
        // Dismiss the incoming call notification posted by SvarlaConnectionService
        cancelTelecomCallNotification()
    }

    /**
     * Propagates VoiceCallManager ENDED state to the active [SvarlaConnection].
     * Maps [CallEndReason] to the appropriate [DisconnectCause], transitions the Telecom
     * framework connection to STATE_DISCONNECTED, and clears the active connection reference.
     * Dismisses the Telecom_Path incoming call notification.
     *
     * Requirements: 9.2
     */
    override fun notifyCallEnded(reason: CallEndReason) {
        activeConnection?.let { connection ->
            val disconnectCause = mapEndReasonToDisconnectCause(reason)
            connection.onCallEnded(disconnectCause)
            activeConnection = null
        }
        pendingIncomingCallId = null
        // Dismiss the incoming call notification posted by SvarlaConnectionService
        cancelTelecomCallNotification()
    }

    private fun cancelTelecomCallNotification() {
        val nm = context.getSystemService(android.app.NotificationManager::class.java)
        nm?.cancel(SvarlaConnectionService.TELECOM_CALL_NOTIFICATION_ID)
        nm?.cancel(FALLBACK_NOTIFICATION_ID)
    }

    /**
     * Posts a high-priority incoming call notification directly (without a foreground service).
     * Used as a fallback when CallForegroundService cannot be started from the background.
     * The fullScreenIntent will wake the screen on locked devices.
     */
    private fun postFallbackIncomingCallNotification(callId: String, remoteNumber: String) {
        val displayNumber = remoteNumber.ifEmpty { "Unknown caller" }

        val fullScreenIntent = IncomingCallActivity.createIntent(context, callId, remoteNumber)
        val fullScreenPendingIntent = PendingIntent.getActivity(
            context, FALLBACK_NOTIFICATION_ID, fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val answerIntent = Intent(context, MainActivity::class.java).apply {
            action = NotificationHandler.ACTION_ANSWER_CALL
            putExtra(NotificationHandler.EXTRA_CALL_ID, callId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val answerPendingIntent = PendingIntent.getActivity(
            context, FALLBACK_NOTIFICATION_ID + 1, answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val declineIntent = Intent(context, CallActionReceiver::class.java).apply {
            action = CallActionReceiver.ACTION_DECLINE
            putExtra(NotificationHandler.EXTRA_CALL_ID, callId)
        }
        val declinePendingIntent = PendingIntent.getBroadcast(
            context, FALLBACK_NOTIFICATION_ID + 2, declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val caller = androidx.core.app.Person.Builder()
            .setName(displayNumber)
            .setImportant(true)
            .build()

        val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_ID_CALLS)
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

        val nm = context.getSystemService(android.app.NotificationManager::class.java)
        nm?.notify(FALLBACK_NOTIFICATION_ID, notification)
        Log.d(TAG, "Posted fallback incoming call notification with fullScreenIntent")
    }

    override fun startForIncomingCall(callId: String, remoteNumber: String) {
        try {
            CallForegroundService.startRinging(context, callId, remoteNumber)
        } catch (e: Exception) {
            // On Android 14+, startForegroundService() may throw ForegroundServiceStartNotAllowedException
            // or SecurityException when the app doesn't have the required exemptions from background.
            // Fall back to posting a high-priority notification directly.
            Log.w(TAG, "Cannot start CallForegroundService, posting notification directly: ${e.message}")
            postFallbackIncomingCallNotification(callId, remoteNumber)
        }
    }

    override fun startForOutboundCall(remoteNumber: String) {
        CallForegroundService.startDialing(context, remoteNumber)
    }

    override fun updateConnected(remoteNumber: String) {
        CallForegroundService.updateConnected(context, remoteNumber)
    }

    override fun stop() {
        CallForegroundService.stop(context)
    }

    /**
     * Routes an incoming call through TelecomManager when PhoneAccount is registered.
     * Calls [TelecomManager.addNewIncomingCall] with the call metadata.
     * Falls back to [startForIncomingCall] (Legacy_Path) if registration status is not
     * REGISTERED or if a [SecurityException] is thrown.
     *
     * Requirements: 4.1, 4.5, 5.1
     */
    override fun handleIncomingCallViaTelecom(callId: String, remoteNumber: String) {
        // Guard against duplicate addNewIncomingCall for the same callId.
        // This can happen when both the push notification path and WebSocket event path
        // trigger handleIncomingCallViaTelecom before the TelecomManager connection is created.
        if (pendingIncomingCallId == callId) {
            Log.d(TAG, "Incoming call $callId already submitted to TelecomManager — skipping duplicate")
            return
        }

        if (phoneAccountRegistrar.registrationStatus.value != RegistrationStatus.REGISTERED) {
            // Fallback to legacy path
            startForIncomingCall(callId, remoteNumber)
            return
        }

        try {
            pendingIncomingCallId = callId
            val extras = Bundle().apply {
                putString(SvarlaConnectionService.EXTRA_CALL_ID, callId)
                putString(SvarlaConnectionService.EXTRA_CALLER_NUMBER, remoteNumber)
                putParcelable(
                    TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE,
                    phoneAccountRegistrar.phoneAccountHandle
                )
            }
            telecomManager.addNewIncomingCall(
                phoneAccountRegistrar.phoneAccountHandle,
                extras
            )
        } catch (e: SecurityException) {
            Log.w(TAG, "addNewIncomingCall failed, falling back to Legacy_Path", e)
            pendingIncomingCallId = null
            startForIncomingCall(callId, remoteNumber)
        }
    }

    /**
     * Routes an outgoing call through TelecomManager when PhoneAccount is registered.
     * Calls [TelecomManager.placeCall] with the destination URI and PhoneAccountHandle extras.
     * Falls back to [startForOutboundCall] (Legacy_Path) if registration status is not
     * REGISTERED or if a [SecurityException] is thrown.
     *
     * Requirements: 7.1, 7.4
     */
    override fun handleOutgoingCallViaTelecom(destinationNumber: String) {
        if (phoneAccountRegistrar.registrationStatus.value != RegistrationStatus.REGISTERED) {
            startForOutboundCall(destinationNumber)
            return
        }

        try {
            val uri = Uri.fromParts(PhoneAccount.SCHEME_TEL, destinationNumber, null)
            val extras = Bundle().apply {
                putParcelable(
                    TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE,
                    phoneAccountRegistrar.phoneAccountHandle
                )
            }
            telecomManager.placeCall(uri, extras)
        } catch (e: SecurityException) {
            Log.w(TAG, "placeCall failed, falling back to Legacy_Path", e)
            startForOutboundCall(destinationNumber)
        }
    }

    /**
     * Maps [CallEndReason] to the appropriate [DisconnectCause] for the Telecom framework.
     */
    private fun mapEndReasonToDisconnectCause(reason: CallEndReason): DisconnectCause {
        return toDisconnectCause(reason)
    }
}
