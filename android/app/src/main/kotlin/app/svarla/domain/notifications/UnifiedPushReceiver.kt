package app.svarla.domain.notifications

import android.content.Context
import android.util.Log
import app.svarla.data.remote.AuthManager
import app.svarla.data.remote.api.ApiClient
import app.svarla.data.remote.sync.SyncManager
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.unifiedpush.android.connector.MessagingReceiver

/**
 * UnifiedPush broadcast receiver.
 *
 * The wake signal only contains {"type":"incoming_sms","id":"..."}.
 * After receiving it, we fetch the actual notification content from
 * GET /api/notifications/:id?type=... and then display it.
 */
class UnifiedPushReceiver : MessagingReceiver() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface ReceiverEntryPoint {
        fun notificationHandler(): NotificationHandler
        fun syncManager(): SyncManager
        fun authManager(): AuthManager
        fun apiClient(): ApiClient
        fun json(): Json
        fun callServiceController(): app.svarla.domain.call.CallServiceController
        fun newDeviceLoginNotifier(): NewDeviceLoginNotifier
    }

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface VoiceCallManagerEntryPoint {
        fun voiceCallManager(): app.svarla.domain.call.VoiceCallManager
    }

    companion object {
        private const val TAG = "UnifiedPushReceiver"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun getEntryPoint(context: Context): ReceiverEntryPoint {
        return EntryPointAccessors.fromApplication(
            context.applicationContext,
            ReceiverEntryPoint::class.java
        )
    }

    override fun onNewEndpoint(context: Context, endpoint: String, instance: String) {
        Log.i(TAG, "New UnifiedPush endpoint received")

        val entryPoint = try {
            getEntryPoint(context)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get entry point for push endpoint registration", e)
            return
        }
        val authManager = entryPoint.authManager()
        val apiClient = entryPoint.apiClient()

        scope.launch {
            val deviceId = authManager.getDeviceId()
            if (deviceId == null) {
                Log.e(TAG, "No device ID, cannot register push endpoint")
                return@launch
            }

            try {
                apiClient.put<Unit>(
                    path = "/api/devices/$deviceId/push-endpoint",
                    body = PushEndpointRequest(pushEndpointUrl = endpoint)
                )
                Log.i(TAG, "Push endpoint registered with server")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to register push endpoint", e)
            }
        }
    }

    override fun onMessage(context: Context, message: ByteArray, instance: String) {
        val messageStr = String(message, Charsets.UTF_8)
        Log.d(TAG, "Wake signal received: $messageStr")

        val entryPoint = getEntryPoint(context)
        val notificationHandler = entryPoint.notificationHandler()
        val syncManager = entryPoint.syncManager()
        val apiClient = entryPoint.apiClient()
        val json = entryPoint.json()

        // Parse the minimal wake signal
        val signal = try {
            json.decodeFromString<WakeSignal>(messageStr)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse wake signal", e)
            return
        }

        // CRITICAL: For high-priority signals (incoming calls), route through TelecomManager
        // IMMEDIATELY (synchronously within onMessage) to use the BroadcastReceiver exemption
        // window. The Telecom_Path (handleIncomingCallViaTelecom) is the primary path — it calls
        // TelecomManager.addNewIncomingCall() which grants background activity start privilege
        // via the Connection's STATE_RINGING state. If the PhoneAccount is not registered or
        // a SecurityException occurs, it automatically falls back to Legacy_Path
        // (CallForegroundService.startRinging via startForIncomingCall).
        //
        // We also acquire a temporary wake lock to keep the CPU alive between the receiver
        // finishing and the service/connection starting. Without this, the CPU can go back
        // to sleep before the call handling takes over. This is critical when the device
        // is in doze with screen off.
        if (signal.priority == "high") {
            try {
                // Acquire a temporary wake lock to bridge receiver → service startup
                val powerManager = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                @Suppress("DEPRECATION")
                val wl = powerManager.newWakeLock(
                    android.os.PowerManager.PARTIAL_WAKE_LOCK,
                    "svarla:push_call_wakelock"
                )
                wl.acquire(10_000) // 10 seconds — released when service takes over

                val callServiceController = entryPoint.callServiceController()
                callServiceController.handleIncomingCallViaTelecom(signal.id, "")
                Log.d(TAG, "High-priority signal routed via Telecom_Path (with legacy fallback): ${signal.id}")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to route high-priority signal via Telecom", e)
            }
        }

        // Ensure sync WebSocket is connected for real-time updates
        syncManager.connect()

        // Fetch actual notification content from the server
        scope.launch {
            // Small delay to ensure server has committed the data before we fetch
            kotlinx.coroutines.delay(500)

            try {
                val notification = fetchNotificationDetail(apiClient, signal)

                // For new_device_login: show notification directly
                if (notification.type == "new_device_login") {
                    val nestedPayload = try { notification.payload?.jsonObject } catch (_: Exception) { null }
                    val deviceName = nestedPayload?.get("deviceLabel")?.jsonPrimitive?.contentOrNull
                        ?: notification.sourceEntityId
                    val newDeviceNotifier = entryPoint.newDeviceLoginNotifier()
                    newDeviceNotifier.showNewDeviceLoginNotification(notification.sourceEntityId, deviceName)
                    Log.d(TAG, "New device login notification shown for: $deviceName")
                    return@launch
                }

                // If we routed this as a high-priority signal (potential incoming call) via
                // Telecom, but the server says it's actually a missed/blocked call (call ended
                // while device was offline), cancel the ringing state.
                if (signal.priority == "high" && notification.type != "incoming_call") {
                    Log.d(TAG, "High-priority signal ${signal.id} resolved to ${notification.type} — cancelling ringing")
                    val voiceCallManager = EntryPointAccessors.fromApplication(
                        context.applicationContext,
                        VoiceCallManagerEntryPoint::class.java
                    ).voiceCallManager()
                    voiceCallManager.handleCallCancelled(signal.id, "caller_disconnect")
                }

                // Convert to NotificationCreatedEvent and let NotificationHandler process it.
                // This is the same path used by WebSocket reconnect, ensuring consistent handling.
                val event = notification.toNotificationCreatedEvent()
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                    notificationHandler.handleNotificationCreated(event)
                }

                Log.d(TAG, "Notification displayed for ${notification.type} (sourceEntityId=${notification.sourceEntityId})")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to fetch notification detail: ${e.message}", e)
                // If this was a high-priority signal and we can't fetch details,
                // the call may still be valid (handled via WebSocket path).
                // Do NOT cancel the ringing — let the inbound timeout or WebSocket
                // events handle the call lifecycle. Cancelling here caused premature
                // call termination when the notification endpoint returned 404 for
                // the internal callId (which is not stored as the call_history ID).
                if (signal.priority == "high") {
                    Log.d(TAG, "Notification fetch failed for high-priority signal ${signal.id} — relying on WebSocket path")
                }
            }
        }
    }

    override fun onUnregistered(context: Context, instance: String) {
        Log.w(TAG, "UnifiedPush unregistered by distributor")
    }

    override fun onRegistrationFailed(context: Context, instance: String) {
        Log.w(TAG, "UnifiedPush registration failed")
    }

    /**
     * Fetch notification details from the server, with one retry on failure
     * (in case the push arrived before the DB commit completed).
     * Returns the full notification entity from GET /api/notifications/:id.
     */
    private suspend fun fetchNotificationDetail(
        apiClient: ApiClient,
        signal: WakeSignal
    ): NotificationApiResponse {
        try {
            return apiClient.get<NotificationApiResponse>(
                path = "/api/notifications/${signal.id}"
            )
        } catch (e: Exception) {
            // Retry once after a delay (handles race condition with DB commit)
            Log.d(TAG, "First fetch attempt failed, retrying in 1s: ${e.message}")
            kotlinx.coroutines.delay(1000)
            return apiClient.get<NotificationApiResponse>(
                path = "/api/notifications/${signal.id}"
            )
        }
    }
}

@Serializable
private data class PushEndpointRequest(
    val pushEndpointUrl: String
)
