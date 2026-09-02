package app.svarla

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import app.svarla.data.remote.AuthManager
import app.svarla.domain.audio.AudioRouter
import app.svarla.domain.call.VoiceCallManager
import app.svarla.domain.contacts.ContactResolver
import app.svarla.domain.layout.FormFactorManager
import app.svarla.domain.notifications.AutoStartHelper
import app.svarla.domain.notifications.NotificationDeliveryPreferences
import app.svarla.domain.notifications.NotificationHandler
import app.svarla.domain.notifications.PushEndpointManager
import app.svarla.domain.version.VersionCheckService
import app.svarla.ui.navigation.AppNavigation
import app.svarla.ui.theme.SvarlaTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var authManager: AuthManager

    @Inject
    lateinit var contactResolver: ContactResolver

    @Inject
    lateinit var voiceCallManager: VoiceCallManager

    @Inject
    lateinit var audioRouter: AudioRouter

    @Inject
    lateinit var formFactorManager: FormFactorManager

    @Inject
    lateinit var notificationHandler: NotificationHandler

    @Inject
    lateinit var deliveryPreferences: NotificationDeliveryPreferences

    @Inject
    lateinit var pushEndpointManager: PushEndpointManager

    @Inject
    lateinit var autoStartHelper: AutoStartHelper

    @Inject
    lateinit var versionCheckService: VersionCheckService

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* granted or not — we proceed either way */ }

    // Number to prefill on the dial pad, set from an external DIAL/VIEW (tel:) or
    // PROCESS_TEXT intent. Backed by Compose state so onNewIntent can update it.
    private var dialPrefill by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        requestNotificationPermissionIfNeeded()

        // Start observing fold state and apply orientation policy
        formFactorManager.observeFoldState(this)

        // Handle notification tap intent (e.g., open conversation for SMS notification)
        handleNotificationIntent(intent)
        dialPrefill = extractDialNumber(intent)

        setContent {
            SvarlaTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    AppNavigation(
                        authManager = authManager,
                        contactResolver = contactResolver,
                        voiceCallManager = voiceCallManager,
                        audioRouter = audioRouter,
                        deliveryPreferences = deliveryPreferences,
                        pushEndpointManager = pushEndpointManager,
                        versionCheckService = versionCheckService,
                        autoStartHelper = autoStartHelper,
                        initialRoute = getInitialRouteFromIntent(intent),
                        dialNumber = dialPrefill,
                        onDialNumberConsumed = { dialPrefill = null }
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleNotificationIntent(intent)
        val number = extractDialNumber(intent)
        if (number != null) {
            dialPrefill = number
        }
    }

    /**
     * Extract a phone number to dial from an external intent:
     *  - ACTION_DIAL / ACTION_VIEW with a `tel:` URI (the "Call" chooser).
     *  - ACTION_PROCESS_TEXT with selected text (the text-selection popup).
     * Returns null if the intent carries no usable number.
     */
    private fun extractDialNumber(intent: Intent?): String? {
        intent ?: return null
        val raw: String? = when (intent.action) {
            Intent.ACTION_DIAL, Intent.ACTION_VIEW -> {
                val data = intent.data
                if (data?.scheme == "tel") {
                    // tel: numbers may be URL-encoded (e.g. %2B for '+').
                    android.net.Uri.decode(data.schemeSpecificPart)
                } else {
                    null
                }
            }
            Intent.ACTION_PROCESS_TEXT -> {
                intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
            }
            else -> null
        }
        val sanitized = raw
            ?.filter { it.isDigit() || it == '+' || it == '*' || it == '#' }
            .orEmpty()
        return sanitized.ifEmpty { null }
    }

    private fun handleNotificationIntent(intent: Intent?) {
        intent ?: return

        // Handle answer/decline actions from notification buttons
        when (intent.action) {
            NotificationHandler.ACTION_ANSWER_CALL -> {
                val callId = intent.getStringExtra(NotificationHandler.EXTRA_CALL_ID) ?: return
                val notificationId = intent.getIntExtra(NotificationHandler.EXTRA_NOTIFICATION_ID, -1)
                if (notificationId != -1) {
                    val nm = getSystemService(android.app.NotificationManager::class.java)
                    nm?.cancel(notificationId)
                }
                notificationHandler.dismissCallNotification(callId)
                voiceCallManager.answerCall(callId)
                return
            }
            NotificationHandler.ACTION_DECLINE_CALL -> {
                val callId = intent.getStringExtra(NotificationHandler.EXTRA_CALL_ID) ?: return
                val notificationId = intent.getIntExtra(NotificationHandler.EXTRA_NOTIFICATION_ID, -1)
                if (notificationId != -1) {
                    val nm = getSystemService(android.app.NotificationManager::class.java)
                    nm?.cancel(notificationId)
                }
                notificationHandler.dismissCallNotification(callId)
                voiceCallManager.declineCall(callId)
                return
            }
        }

        // Dismiss the notification that was tapped
        val notificationId = intent.getIntExtra(
            NotificationHandler.EXTRA_NOTIFICATION_ID, -1
        )
        if (notificationId != -1) {
            val nm = getSystemService(android.app.NotificationManager::class.java)
            nm?.cancel(notificationId)
        }

        // If tapping an incoming call notification, dismiss it (UI will show call screen via state)
        val notificationType = intent.getStringExtra(NotificationHandler.EXTRA_NOTIFICATION_TYPE)
        if (notificationType == NotificationHandler.TYPE_INCOMING_CALL) {
            val callId = intent.getStringExtra(NotificationHandler.EXTRA_CALL_ID)
            if (callId != null) {
                notificationHandler.dismissCallNotification(callId)
            }
        }
    }

    /**
     * Determine the initial navigation route based on notification tap extras.
     * Incoming call notifications don't need a special route — the call state overlay in
     * HomeScreen handles displaying the IncomingCallScreen when callState == RINGING.
     */
    private fun getInitialRouteFromIntent(intent: Intent?): String? {
        intent ?: return null
        val notificationType = intent.getStringExtra(NotificationHandler.EXTRA_NOTIFICATION_TYPE)
            ?: return null

        return when (notificationType) {
            NotificationHandler.TYPE_INCOMING_SMS -> {
                val phoneNumber = intent.getStringExtra(NotificationHandler.EXTRA_PHONE_NUMBER)
                val providerNumber = intent.getStringExtra(NotificationHandler.EXTRA_PROVIDER_NUMBER)
                if (phoneNumber != null && providerNumber != null) {
                    "conversation_detail/${java.net.URLEncoder.encode(providerNumber, "UTF-8")}/${java.net.URLEncoder.encode(phoneNumber, "UTF-8")}"
                } else null
            }
            // Incoming call: no route needed, HomeScreen shows IncomingCallScreen when RINGING
            NotificationHandler.TYPE_INCOMING_CALL -> null
            // Missed/blocked calls: navigate to call history tab
            NotificationHandler.TYPE_MISSED_CALL -> "home?tab=calls"
            NotificationHandler.TYPE_BLOCKED_CALL -> "home?tab=calls"
            // New device login: navigate to settings tab (shows devices)
            "new_device_login" -> "home?tab=settings"
            else -> null
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val permission = Manifest.permission.POST_NOTIFICATIONS
            if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
                notificationPermissionLauncher.launch(permission)
            }
        }

        // On Android 14+, USE_FULL_SCREEN_INTENT requires explicit user grant for non-phone apps.
        // Without this, the incoming call full-screen UI won't show over the lock screen.
        requestFullScreenIntentPermission()
    }

    private fun requestFullScreenIntentPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val notificationManager = getSystemService(android.app.NotificationManager::class.java)
            if (!notificationManager.canUseFullScreenIntent()) {
                val intent = Intent(
                    android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                    android.net.Uri.parse("package:$packageName")
                )
                startActivity(intent)
            }
        }
    }
}
