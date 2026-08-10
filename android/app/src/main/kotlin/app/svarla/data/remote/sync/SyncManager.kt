package app.svarla.data.remote.sync

import android.util.Log
import app.svarla.data.remote.AuthManager
import app.svarla.data.remote.api.SyncApi
import app.svarla.data.remote.dto.WebSocketEvent
import app.svarla.domain.call.NetworkMonitor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Connection state for the sync layer.
 */
enum class SyncConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    POLLING_FALLBACK
}

/**
 * Manages real-time synchronization with the backend server via WebSocket.
 *
 * Features:
 * - OkHttp WebSocket connection with session token authentication
 * - Exponential backoff reconnection (1s → 2s → 4s → ... → 60s max)
 * - Fallback to polling GET /api/sync/state every 10s after 3 consecutive WebSocket failures
 * - Event dispatching via SharedFlow for repositories to observe
 *
 * Requirements covered: 6.7, 7.6, 11.2
 */
@Singleton
class SyncManager @Inject constructor(
    okHttpClient: OkHttpClient,
    private val authManager: AuthManager,
    private val syncApi: SyncApi,
    private val json: Json,
    private val networkMonitor: NetworkMonitor
) {
    companion object {
        private const val TAG = "SyncManager"
        private const val INITIAL_BACKOFF_MS = 1000L
        private const val MAX_BACKOFF_MS = 60_000L
        private const val MAX_CONSECUTIVE_FAILURES = 3
        private const val POLLING_INTERVAL_MS = 10_000L
    }

    // WebSocket client with no read timeout and periodic pings to keep connection alive
    private val wsClient: OkHttpClient = okHttpClient.newBuilder()
        .readTimeout(0, java.util.concurrent.TimeUnit.SECONDS)
        .pingInterval(25, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var pollingJob: Job? = null
    private var networkObserverJob: Job? = null

    private var currentBackoffMs = INITIAL_BACKOFF_MS
    private var consecutiveFailures = 0

    /** Whether connect() has been called and disconnect() has not. */
    private var wantConnection = false

    private val _connectionState = MutableStateFlow(SyncConnectionState.DISCONNECTED)
    val connectionState: StateFlow<SyncConnectionState> = _connectionState.asStateFlow()

    private val _events = MutableSharedFlow<WebSocketEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<WebSocketEvent> = _events.asSharedFlow()

    /**
     * Start the sync connection. Attempts WebSocket first, falls back to polling
     * after [MAX_CONSECUTIVE_FAILURES] consecutive WebSocket failures.
     */
    fun connect() {
        if (_connectionState.value == SyncConnectionState.CONNECTED ||
            _connectionState.value == SyncConnectionState.CONNECTING
        ) {
            return
        }

        val serverUrl = authManager.getServerUrl() ?: run {
            Log.w(TAG, "Cannot connect: no server URL configured")
            return
        }
        val token = authManager.getSessionToken() ?: run {
            Log.w(TAG, "Cannot connect: no session token available")
            return
        }

        wantConnection = true
        startNetworkObserver()

        if (!networkMonitor.isConnected()) {
            Log.d(TAG, "No network available, waiting for connectivity")
            _connectionState.value = SyncConnectionState.RECONNECTING
            return
        }

        connectWebSocket(serverUrl, token)
    }

    /**
     * Disconnect and stop all sync activity.
     */
    fun disconnect() {
        wantConnection = false
        networkObserverJob?.cancel()
        networkObserverJob = null
        reconnectJob?.cancel()
        reconnectJob = null
        pollingJob?.cancel()
        pollingJob = null
        webSocket?.close(1000, "Client disconnect")
        webSocket = null
        _connectionState.value = SyncConnectionState.DISCONNECTED
        consecutiveFailures = 0
        currentBackoffMs = INITIAL_BACKOFF_MS
    }

    /**
     * Force a reconnect. Used when the connection is known to be stale.
     */
    fun reconnect() {
        disconnect()
        connect()
    }

    /**
     * Connect if not already connected or actively connecting.
     * Used on foreground resume — if we were waiting for network (RECONNECTING)
     * and it's now available, kick off a fresh connection attempt.
     */
    fun connectIfNeeded() {
        when (_connectionState.value) {
            SyncConnectionState.CONNECTED,
            SyncConnectionState.CONNECTING -> {
                // Already active — do nothing
            }
            SyncConnectionState.RECONNECTING -> {
                // We were waiting — check if network is back now
                if (networkMonitor.isConnected()) {
                    Log.d(TAG, "Foreground resume with network available, reconnecting")
                    consecutiveFailures = 0
                    currentBackoffMs = INITIAL_BACKOFF_MS
                    reconnectJob?.cancel()
                    pollingJob?.cancel()

                    val serverUrl = authManager.getServerUrl()
                    val token = authManager.getSessionToken()
                    if (serverUrl != null && token != null) {
                        connectWebSocket(serverUrl, token)
                    }
                }
            }
            SyncConnectionState.DISCONNECTED,
            SyncConnectionState.POLLING_FALLBACK -> {
                connect()
            }
        }
    }

    private fun connectWebSocket(serverUrl: String, token: String) {
        _connectionState.value = SyncConnectionState.CONNECTING

        val wsUrl = serverUrl
            .replace("https://", "wss://")
            .replace("http://", "ws://")
            .trimEnd('/') + "/ws"

        val request = Request.Builder()
            .url(wsUrl)
            .header("Authorization", "Bearer $token")
            .build()

        webSocket = wsClient.newWebSocket(request, createWebSocketListener())
    }

    private fun createWebSocketListener(): WebSocketListener {
        return object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "WebSocket connected")
                _connectionState.value = SyncConnectionState.CONNECTED
                consecutiveFailures = 0
                currentBackoffMs = INITIAL_BACKOFF_MS
                // Stop polling if it was active
                pollingJob?.cancel()
                pollingJob = null
                // Emit a reconnect event so consumers can refresh their data
                scope.launch {
                    _events.emit(WebSocketEvent(type = "connected", data = null))
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val event = json.decodeFromString<WebSocketEvent>(text)
                    scope.launch {
                        _events.emit(event)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to parse WebSocket message: $text", e)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket closing: $code $reason")
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket closed: $code $reason")
                handleDisconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (t is java.net.SocketException || t is java.io.EOFException) {
                    Log.d(TAG, "WebSocket disconnected: ${t.message}")
                } else {
                    Log.e(TAG, "WebSocket failure", t)
                }
                handleDisconnect()
            }
        }
    }

    private fun handleDisconnect() {
        this.webSocket = null

        // If there's no network, don't bother retrying — the network observer will
        // trigger a reconnect once connectivity is restored.
        if (!networkMonitor.isConnected()) {
            Log.d(TAG, "Network lost, suspending reconnection until connectivity returns")
            _connectionState.value = SyncConnectionState.RECONNECTING
            reconnectJob?.cancel()
            pollingJob?.cancel()
            return
        }

        consecutiveFailures++

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            Log.w(TAG, "WebSocket failed $consecutiveFailures consecutive times, switching to polling")
            startPollingFallback()
        } else {
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        _connectionState.value = SyncConnectionState.RECONNECTING

        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            Log.d(TAG, "Reconnecting in ${currentBackoffMs}ms (attempt $consecutiveFailures)")
            delay(currentBackoffMs)

            // Double the backoff for next attempt, capped at max
            currentBackoffMs = (currentBackoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)

            val serverUrl = authManager.getServerUrl()
            val token = authManager.getSessionToken()

            if (serverUrl != null && token != null && isActive) {
                connectWebSocket(serverUrl, token)
            } else {
                _connectionState.value = SyncConnectionState.DISCONNECTED
            }
        }
    }

    private fun startPollingFallback() {
        _connectionState.value = SyncConnectionState.POLLING_FALLBACK
        reconnectJob?.cancel()
        reconnectJob = null

        pollingJob?.cancel()
        pollingJob = scope.launch {
            while (isActive) {
                try {
                    val state = syncApi.getSyncState()
                    // Emit a synthetic sync event for full state
                    _events.emit(WebSocketEvent(type = "full_sync", data = null))
                    Log.d(TAG, "Polling sync successful")
                } catch (e: Exception) {
                    Log.e(TAG, "Polling sync failed", e)
                }
                delay(POLLING_INTERVAL_MS)
            }
        }

        // Also periodically try to reconnect WebSocket while polling
        reconnectJob = scope.launch {
            while (isActive) {
                delay(MAX_BACKOFF_MS) // Try to reconnect every 60s while polling
                val serverUrl = authManager.getServerUrl()
                val token = authManager.getSessionToken()
                if (serverUrl != null && token != null) {
                    Log.d(TAG, "Attempting WebSocket reconnect while polling")
                    connectWebSocket(serverUrl, token)
                    break // If connection attempt is made, exit this loop
                }
            }
        }
    }

    /**
     * Send an event to the server via WebSocket.
     * Returns true if the message was enqueued for sending, false otherwise.
     */
    fun send(event: WebSocketEvent): Boolean {
        val ws = webSocket ?: return false
        return try {
            val text = json.encodeToString(WebSocketEvent.serializer(), event)
            ws.send(text)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send WebSocket message", e)
            false
        }
    }

    /**
     * Observes network connectivity changes. When the network comes back and
     * we still want a connection, reset backoff and immediately reconnect.
     * When the network is lost, cancel retries to avoid pointless log spam.
     */
    private fun startNetworkObserver() {
        if (networkObserverJob?.isActive == true) return

        networkObserverJob = scope.launch {
            networkMonitor.isNetworkAvailable.collectLatest { isAvailable ->
                if (isAvailable && wantConnection) {
                    // Network restored — reset state and reconnect fresh
                    if (_connectionState.value != SyncConnectionState.CONNECTED &&
                        _connectionState.value != SyncConnectionState.CONNECTING
                    ) {
                        Log.d(TAG, "Network restored, reconnecting WebSocket")
                        consecutiveFailures = 0
                        currentBackoffMs = INITIAL_BACKOFF_MS
                        reconnectJob?.cancel()
                        pollingJob?.cancel()

                        val serverUrl = authManager.getServerUrl()
                        val token = authManager.getSessionToken()
                        if (serverUrl != null && token != null) {
                            connectWebSocket(serverUrl, token)
                        }
                    }
                } else if (!isAvailable) {
                    // Network lost — stop retrying, we'll reconnect when it returns
                    Log.d(TAG, "Network lost, pausing sync retries")
                    reconnectJob?.cancel()
                    pollingJob?.cancel()
                    if (_connectionState.value != SyncConnectionState.DISCONNECTED) {
                        _connectionState.value = SyncConnectionState.RECONNECTING
                    }
                }
            }
        }
    }
}
