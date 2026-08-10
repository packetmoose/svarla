package app.svarla.domain.notifications

import android.util.Log
import app.svarla.data.remote.sync.SyncManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Observes WebSocket events for new device logins and shows persistent notifications.
 * Initialized at app startup and listens for "new_device_login" events from the SyncManager.
 */
@Singleton
class DeviceLoginEventObserver @Inject constructor(
    private val syncManager: SyncManager,
    private val newDeviceLoginNotifier: NewDeviceLoginNotifier
) {
    companion object {
        private const val TAG = "DeviceLoginObserver"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var isObserving = false

    /**
     * Start observing WebSocket events for new device logins.
     * Safe to call multiple times — only starts once.
     */
    fun startObserving() {
        if (isObserving) return
        isObserving = true

        scope.launch {
            syncManager.events.collect { event ->
                if (event.type == "new_device_login") {
                    handleNewDeviceLogin(event)
                }
            }
        }
    }

    private fun handleNewDeviceLogin(event: app.svarla.data.remote.dto.WebSocketEvent) {
        try {
            val data = event.data?.jsonObject ?: return
            val deviceId = data["deviceId"]?.jsonPrimitive?.content ?: return
            val deviceName = data["deviceName"]?.jsonPrimitive?.content ?: "Unknown device"

            Log.d(TAG, "New device login detected: $deviceName ($deviceId)")
            newDeviceLoginNotifier.showNewDeviceLoginNotification(deviceId, deviceName)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to handle new_device_login event", e)
        }
    }
}
