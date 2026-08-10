package app.svarla.domain.notifications

import android.content.Context
import android.util.Log
import app.svarla.data.remote.AuthManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import org.unifiedpush.android.connector.UnifiedPush
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Minimal wake signal received via UnifiedPush.
 * Contains ONLY an ID and a priority level — no notification type metadata.
 * The app fetches actual content (including type) from the server after waking.
 *
 * Priority levels:
 * - "high": requires immediate handling (potential incoming call needing Telecom routing)
 * - "normal": can be fetched and displayed asynchronously
 */
@Serializable
data class WakeSignal(
    val id: String,
    val priority: String = "normal" // "high" or "normal"
)

/**
 * Push registration state.
 */
enum class PushState {
    /** Not registered with any UnifiedPush distributor */
    UNREGISTERED,
    /** Registration in progress (waiting for endpoint callback) */
    REGISTERING,
    /** Successfully registered with a distributor and endpoint sent to server */
    REGISTERED,
    /** Registration failed — no push delivery available */
    FAILED
}

/**
 * Manages notification delivery lifecycle.
 *
 * Responsibilities:
 * - Discover UnifiedPush distributors on the device
 * - Register with a distributor to get a push endpoint
 * - Fall back to persistent WebSocket when UnifiedPush is unavailable
 * - Respect user preference (UNIFIED_PUSH / WEBSOCKET / NONE)
 * - Unregister/teardown on logout
 *
 * The actual message handling is done directly in UnifiedPushReceiver
 * using Hilt EntryPoints (works even when the app process was dead).
 */
@Singleton
class PushEndpointManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val authManager: AuthManager,
    private val notificationHandler: NotificationHandler,
    private val deliveryPreferences: NotificationDeliveryPreferences
) {
    companion object {
        private const val TAG = "PushEndpointManager"
    }

    private val _pushState = MutableStateFlow(PushState.UNREGISTERED)
    val pushState: StateFlow<PushState> = _pushState.asStateFlow()

    /** Tracks the currently active mode to avoid unnecessary stop/start cycles. */
    private var currentActiveMode: NotificationDeliveryMode = NotificationDeliveryMode.NONE

    /**
     * Returns true if UnifiedPush distributors are available on the device.
     */
    fun isUnifiedPushAvailable(): Boolean {
        return try {
            UnifiedPush.getDistributors(context).isNotEmpty()
        } catch (e: Exception) {
            Log.e(TAG, "Error checking UnifiedPush availability", e)
            false
        }
    }

    /**
     * Initialize notification delivery based on user preference.
     * Called after successful authentication.
     *
     * If setup hasn't been completed yet (first login), this only registers
     * notification channels. The actual mode activation is deferred until the
     * user completes the setup dialog (or auto-selects UnifiedPush if available).
     */
    fun initialize() {
        Log.d(TAG, "Initializing notification delivery")

        // Always create notification channels
        try {
            notificationHandler.registerForPush()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create notification channels", e)
        }

        val mode = deliveryPreferences.getStoredMode()
        activateMode(mode)
    }

    /**
     * Activate a specific delivery mode. Tears down any previous mode first,
     * unless the requested mode is already active (idempotent for restarts).
     */
    fun activateMode(mode: NotificationDeliveryMode) {
        Log.d(TAG, "Activating delivery mode: $mode")

        if (mode == currentActiveMode && _pushState.value == PushState.REGISTERED) {
            Log.d(TAG, "Mode $mode already active, ensuring service is running")
            // For WebSocket mode, just ensure the service is started (no-op if already running)
            if (mode == NotificationDeliveryMode.WEBSOCKET) {
                PushWebSocketService.start(context)
            }
            return
        }

        // Teardown previous mode, but skip stopping the WebSocket service if we're
        // about to start it again (avoids a stop/start race on process restart).
        teardownCurrentMode(keepWebSocket = mode == NotificationDeliveryMode.WEBSOCKET)

        currentActiveMode = mode
        when (mode) {
            NotificationDeliveryMode.UNIFIED_PUSH -> initializeUnifiedPush()
            NotificationDeliveryMode.WEBSOCKET -> startWebSocketService()
            NotificationDeliveryMode.NONE -> {
                Log.d(TAG, "No background notification delivery configured")
                _pushState.value = PushState.UNREGISTERED
            }
        }
    }

    /**
     * Tear down all notification delivery. Called on logout.
     */
    fun teardown() {
        Log.d(TAG, "Tearing down notification delivery")
        teardownCurrentMode(keepWebSocket = false)
    }

    /**
     * Called by the receiver when endpoint registration succeeds.
     */
    fun markRegistered() {
        _pushState.value = PushState.REGISTERED
    }

    /**
     * Called by the receiver when endpoint registration fails.
     */
    fun markFailed() {
        _pushState.value = PushState.FAILED
    }

    // ========================================================================
    // Private helpers
    // ========================================================================

    private fun initializeUnifiedPush() {
        try {
            val distributors = UnifiedPush.getDistributors(context)
            Log.d(TAG, "Available UnifiedPush distributors: ${distributors.size}")

            if (distributors.isEmpty()) {
                Log.w(TAG, "No UnifiedPush distributor found on device.")
                _pushState.value = PushState.FAILED
                return
            }

            val distributor = distributors.first()
            Log.d(TAG, "Registering with UnifiedPush distributor: $distributor")

            UnifiedPush.saveDistributor(context, distributor)
            UnifiedPush.registerApp(context)
            _pushState.value = PushState.REGISTERING
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize UnifiedPush registration", e)
            _pushState.value = PushState.FAILED
        }
    }

    private fun startWebSocketService() {
        Log.d(TAG, "Starting persistent WebSocket service")
        _pushState.value = PushState.REGISTERED
        PushWebSocketService.start(context)
    }

    private fun teardownCurrentMode(keepWebSocket: Boolean = false) {
        // Teardown UnifiedPush
        try {
            UnifiedPush.unregisterApp(context)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to unregister from UnifiedPush (may not have been registered)", e)
        }

        // Stop WebSocket service (unless we're about to restart it)
        if (!keepWebSocket) {
            try {
                PushWebSocketService.stop(context)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to stop WebSocket service", e)
            }
        }

        currentActiveMode = NotificationDeliveryMode.NONE
        _pushState.value = PushState.UNREGISTERED
    }
}
