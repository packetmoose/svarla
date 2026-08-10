package app.svarla.domain.notifications

import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Persists and exposes the user's chosen notification delivery mode.
 *
 * On first launch after auth, PushEndpointManager probes for UnifiedPush availability
 * and writes the initial mode. The user can override it later from Settings.
 */
@Singleton
class NotificationDeliveryPreferences @Inject constructor(
    private val prefs: SharedPreferences
) {
    companion object {
        private const val KEY_DELIVERY_MODE = "notification_delivery_mode"
        private const val KEY_SETUP_COMPLETED = "notification_setup_completed"
    }

    private val _mode = MutableStateFlow(getStoredMode())
    val mode: StateFlow<NotificationDeliveryMode> = _mode.asStateFlow()

    /**
     * Whether the first-time notification setup dialog has been completed.
     */
    val isSetupCompleted: Boolean
        get() = prefs.getBoolean(KEY_SETUP_COMPLETED, false)

    fun getStoredMode(): NotificationDeliveryMode {
        val stored = prefs.getString(KEY_DELIVERY_MODE, null)
        return when (stored) {
            "UNIFIED_PUSH" -> NotificationDeliveryMode.UNIFIED_PUSH
            "WEBSOCKET" -> NotificationDeliveryMode.WEBSOCKET
            "NONE" -> NotificationDeliveryMode.NONE
            else -> NotificationDeliveryMode.NONE
        }
    }

    fun setMode(mode: NotificationDeliveryMode) {
        prefs.edit().putString(KEY_DELIVERY_MODE, mode.name).apply()
        _mode.value = mode
    }

    fun markSetupCompleted() {
        prefs.edit().putBoolean(KEY_SETUP_COMPLETED, true).apply()
    }
}
