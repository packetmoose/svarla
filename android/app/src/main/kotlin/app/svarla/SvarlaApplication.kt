package app.svarla

import android.app.Application
import android.content.SharedPreferences
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.svarla.data.remote.AuthManager
import app.svarla.data.remote.sync.SyncManager
import app.svarla.domain.call.PhoneAccountRegistrar
import app.svarla.domain.notifications.DeviceLoginEventObserver
import app.svarla.domain.notifications.NotificationChannels
import app.svarla.domain.notifications.NotificationDeliveryMode
import app.svarla.domain.notifications.NotificationDeliveryPreferences
import app.svarla.domain.notifications.PushEndpointManager
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltAndroidApp
class SvarlaApplication : Application() {

    @Inject lateinit var authManager: AuthManager
    @Inject lateinit var syncManager: SyncManager
    @Inject lateinit var pushEndpointManager: PushEndpointManager
    @Inject lateinit var phoneAccountRegistrar: PhoneAccountRegistrar
    @Inject lateinit var deviceLoginEventObserver: DeviceLoginEventObserver
    @Inject lateinit var sharedPreferences: SharedPreferences
    @Inject lateinit var badgeManager: app.svarla.domain.badge.BadgeManager
    @Inject lateinit var deliveryPreferences: NotificationDeliveryPreferences

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate() {
        super.onCreate()
        NotificationChannels.createAll(this)

        // Register or verify PhoneAccount with TelecomManager on startup
        val previouslyRegistered = sharedPreferences.getBoolean("phone_account_registered", false)
        if (previouslyRegistered) {
            phoneAccountRegistrar.verifyRegistration()
        } else {
            phoneAccountRegistrar.register()
        }

        // Connect WebSocket and push delivery when authenticated, disconnect when not
        appScope.launch {
            authManager.isAuthenticated.collectLatest { isAuthenticated ->
                if (isAuthenticated) {
                    syncManager.connect()
                    pushEndpointManager.initialize()
                    deviceLoginEventObserver.startObserving()
                    badgeManager.initialize()
                } else {
                    syncManager.disconnect()
                    pushEndpointManager.teardown()
                }
            }
        }

        // React to delivery mode changes at runtime (user changes setting)
        appScope.launch {
            deliveryPreferences.mode.collectLatest { mode ->
                if (authManager.hasValidSession()) {
                    pushEndpointManager.activateMode(mode)
                }
            }
        }

        // Reconnect WebSocket when app returns to foreground
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                // App moved to foreground — reconnect only if disconnected
                isInForeground = true
                if (authManager.hasValidSession()) {
                    syncManager.connectIfNeeded()
                }
            }

            override fun onStop(owner: LifecycleOwner) {
                isInForeground = false
            }
        })
    }

    companion object {
        /**
         * Whether any Activity is currently in the foreground (between onStart/onStop).
         * Used to suppress heads-up call notifications when the app is already showing
         * the full-screen incoming call UI.
         */
        @Volatile
        var isInForeground: Boolean = false
            private set
    }
}
