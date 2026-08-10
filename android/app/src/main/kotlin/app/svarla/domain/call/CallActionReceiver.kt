package app.svarla.domain.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import app.svarla.domain.notifications.NotificationHandler
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * Broadcast receiver for call notification actions (Hang Up, Decline).
 *
 * Using a BroadcastReceiver instead of an Activity intent for these actions
 * because we don't want to bring the app to the foreground — we just want to
 * end/decline the call silently.
 */
@AndroidEntryPoint
class CallActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "CallActionReceiver"
        const val ACTION_HANG_UP = "app.svarla.action.HANG_UP_CALL"
        const val ACTION_DECLINE = "app.svarla.action.DECLINE_CALL"
    }

    @Inject
    lateinit var voiceCallManager: VoiceCallManager

    @Inject
    lateinit var notificationHandler: NotificationHandler

    override fun onReceive(context: Context, intent: Intent?) {
        when (intent?.action) {
            ACTION_HANG_UP -> {
                Log.d(TAG, "Hang up action received from notification")
                voiceCallManager.endCall()
            }
            ACTION_DECLINE -> {
                val callId = intent.getStringExtra(NotificationHandler.EXTRA_CALL_ID)
                Log.d(TAG, "Decline action received from notification, callId=$callId")
                if (callId != null) {
                    // Use the active callId from VoiceCallManager if available, because
                    // the notification intent may contain a stale/temporary ID (e.g., the
                    // push notification UUID used before the real server callId was fetched).
                    val activeCallId = voiceCallManager.callState.value.activeCallInfo?.callId
                    val effectiveCallId = if (!activeCallId.isNullOrEmpty()) activeCallId else callId
                    Log.d(TAG, "Declining with effectiveCallId=$effectiveCallId (notification=$callId, active=$activeCallId)")
                    notificationHandler.dismissCallNotification(effectiveCallId)
                    voiceCallManager.declineCall(effectiveCallId)
                } else {
                    voiceCallManager.endCall()
                }
            }
        }
    }
}
