package app.svarla

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import app.svarla.domain.call.CallStatus
import app.svarla.domain.call.VoiceCallManager
import app.svarla.domain.contacts.ContactResolver
import app.svarla.domain.notifications.NotificationHandler
import app.svarla.ui.screens.call.IncomingCallScreen
import app.svarla.ui.theme.SvarlaTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * Dedicated activity for displaying the incoming call UI over the lock screen.
 *
 * This activity is launched by the fullScreenIntent of the incoming call notification.
 * It configures itself to:
 * - Show over the lock screen (setShowWhenLocked)
 * - Turn on the screen (setTurnScreenOn)
 * - Dismiss the keyguard when the user answers
 * - Keep the screen on while ringing
 *
 * When the call is answered, declined, or cancelled, this activity finishes and
 * the main call screen in MainActivity takes over.
 */
@AndroidEntryPoint
class IncomingCallActivity : ComponentActivity() {

    @Inject
    lateinit var voiceCallManager: VoiceCallManager

    @Inject
    lateinit var contactResolver: ContactResolver

    @Inject
    lateinit var notificationHandler: NotificationHandler

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        configureForLockScreen()

        val callId = intent?.getStringExtra(EXTRA_CALL_ID) ?: ""
        val callerNumber = intent?.getStringExtra(EXTRA_CALLER_NUMBER) ?: ""

        setContent {
            SvarlaTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val callState by voiceCallManager.callState.collectAsState()

                    // Finish when call transitions to CONNECTED, ENDED, or DIALING
                    // (answered, declined, cancelled, or timed out).
                    // Allow IDLE (state hasn't transitioned yet on cold start) and RINGING.
                    when (callState.status) {
                        CallStatus.CONNECTED -> {
                            // Call was answered — go to main app
                            val mainIntent = Intent(this@IncomingCallActivity, MainActivity::class.java).apply {
                                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                            }
                            startActivity(mainIntent)
                            finish()
                            return@Surface
                        }
                        CallStatus.ENDED, CallStatus.DIALING -> {
                            finish()
                            return@Surface
                        }
                        CallStatus.IDLE, CallStatus.RINGING -> {
                            // Show the incoming call UI
                        }
                    }

                    val activeInfo = callState.activeCallInfo
                    val number = activeInfo?.remoteNumber.takeIf { !it.isNullOrEmpty() } ?: callerNumber
                    val contactName = contactResolver.resolveContactName(number)

                    IncomingCallScreen(
                        callerNumber = number,
                        contactName = contactName,
                        providerNumberLabel = activeInfo?.providerNumberLabel,
                        providerNumberColor = activeInfo?.providerNumberColor,
                        onAnswer = {
                            val id = activeInfo?.callId.takeIf { !it.isNullOrEmpty() } ?: callId
                            notificationHandler.dismissCallNotification(id)
                            voiceCallManager.answerCall(id)
                            // Launch MainActivity for the active call screen
                            val mainIntent = Intent(this@IncomingCallActivity, MainActivity::class.java).apply {
                                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                            }
                            startActivity(mainIntent)
                            finish()
                        },
                        onDecline = {
                            val id = activeInfo?.callId.takeIf { !it.isNullOrEmpty() } ?: callId
                            notificationHandler.dismissCallNotification(id)
                            voiceCallManager.declineCall(id)
                            finish()
                        }
                    )
                }
            }
        }
    }

    /**
     * Configures this activity to display over the lock screen and turn on the screen.
     */
    private fun configureForLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)

            // Request keyguard dismissal so if user answers, they don't need to unlock again
            val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            keyguardManager.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            )
        }

        // Keep screen on while this activity is showing
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    companion object {
        const val EXTRA_CALL_ID = "incoming_call_id"
        const val EXTRA_CALLER_NUMBER = "incoming_caller_number"

        /**
         * Creates an intent to launch the IncomingCallActivity.
         */
        fun createIntent(context: Context, callId: String, callerNumber: String): Intent {
            return Intent(context, IncomingCallActivity::class.java).apply {
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_CALLER_NUMBER, callerNumber)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS or
                    Intent.FLAG_ACTIVITY_NO_USER_ACTION
            }
        }
    }
}
