package app.svarla.ui.screens.call

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.svarla.data.local.dao.CallHistoryDao
import app.svarla.data.local.entity.CallHistoryEntry
import app.svarla.data.local.entity.CallType
import app.svarla.data.remote.api.CallsApi
import app.svarla.data.remote.dto.CallHistoryDto
import app.svarla.data.remote.sync.SyncManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import javax.inject.Inject

/**
 * UI model for a call history entry with resolved contact name.
 */
data class CallHistoryUiEntry(
    val entry: CallHistoryEntry,
    val contactName: String?,
    val isUnseen: Boolean = false,
    val providerNumberLabel: String? = null,
    val providerNumberColor: String = "#6750A4"
) {
    val displayName: String get() = contactName ?: entry.phoneNumber
    val hasContact: Boolean get() = contactName != null
}

/**
 * ViewModel for the Call History screen.
 *
 * Fetches call history from the server and caches it locally in Room.
 * Observes the local Room database for reactive updates (new calls arrive via sync).
 * Listens for call_history_update WebSocket events to keep the list current.
 */
@HiltViewModel
class CallHistoryViewModel @Inject constructor(
    private val callsApi: CallsApi,
    private val callHistoryDao: CallHistoryDao,
    private val syncManager: SyncManager,
    private val contactResolver: app.svarla.domain.contacts.ContactResolver,
    private val voiceCallManager: app.svarla.domain.call.VoiceCallManager,
    private val badgeManager: app.svarla.domain.badge.BadgeManager,
    private val notificationHandler: app.svarla.domain.notifications.NotificationHandler,
    private val providerNumberDao: app.svarla.data.local.dao.ProviderNumberDao
) : ViewModel() {

    companion object {
        private const val TAG = "CallHistoryVM"
    }

    private val _callHistory = MutableStateFlow<List<CallHistoryUiEntry>>(emptyList())
    val callHistory: StateFlow<List<CallHistoryUiEntry>> = _callHistory.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _hasLoadedFromCache = MutableStateFlow(false)
    val hasLoadedFromCache: StateFlow<Boolean> = _hasLoadedFromCache.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /** Number of unseen missed/blocked entries at the time the screen was opened. */
    private var unseenCount: Int = 0

    init {
        observeLocalCallHistory()
        observeWebSocketEvents()
        syncFromServer()
    }

    /**
     * Called each time the call history screen becomes visible.
     * Refreshes badge counts from the server, applies unseen indicators,
     * and marks missed calls as viewed. This handles the case where the
     * ViewModel survives navigation (scoped to nav graph) and new missed
     * calls arrive between visits.
     */
    fun onScreenEntered() {
        viewModelScope.launch {
            // Trigger server refresh
            badgeManager.refreshCounts()

            // Wait for the StateFlow to settle after the server response.
            // BadgeManager.refreshCounts() launches a coroutine on Dispatchers.IO that
            // fetches counts and updates the StateFlow. We observe the flow and wait
            // for either a positive count or a short timeout (covers the case where
            // the count genuinely is 0 after server confirms).
            try {
                withTimeout(2000) {
                    unseenCount = badgeManager.unseenMissedCalls.first { it > 0 }
                }
            } catch (_: Exception) {
                // Timeout or cancellation — use whatever value the flow has now
                unseenCount = badgeManager.unseenMissedCalls.value
            }

            // Apply the unseen indicators to already-loaded items
            refreshUnseenIndicators()

            // Now mark as viewed (user is looking at the list)
            badgeManager.markMissedCallsAsViewed()
            notificationHandler.dismissAllMissedCallNotifications()
        }
    }

    /**
     * Re-apply unseen indicators to the current call history list once
     * the true unseen count becomes available.
     */
    private fun refreshUnseenIndicators() {
        val current = _callHistory.value
        if (current.isEmpty() || unseenCount == 0) return
        var remaining = unseenCount
        _callHistory.value = current.map { entry ->
            val isUnseen = remaining > 0 &&
                (entry.entry.callType == CallType.MISSED || entry.entry.callType == CallType.BLOCKED)
            if (isUnseen) remaining--
            entry.copy(isUnseen = isUnseen)
        }
    }

    /**
     * Called when the user leaves the call history screen.
     * Clears the unseen dots so next time entries before this point won't show as new.
     */
    fun onScreenExited() {
        _callHistory.value = _callHistory.value.map { it.copy(isUnseen = false) }
    }

    /**
     * Observe local Room call history for real-time updates.
     */
    private fun observeLocalCallHistory() {
        viewModelScope.launch {
            callHistoryDao.getAll().collect { entries ->
                // Emit a fast first pass immediately so cached data renders
                // without waiting for contact name / provider label resolution.
                val fastEntries = entries.map { entry ->
                    var remainingUnseen = unseenCount
                    val isUnseen = remainingUnseen > 0 &&
                        (entry.callType == CallType.MISSED || entry.callType == CallType.BLOCKED)
                    if (isUnseen) remainingUnseen--
                    CallHistoryUiEntry(
                        entry = entry,
                        contactName = null,
                        isUnseen = isUnseen,
                        providerNumberLabel = entry.providerNumber,
                        providerNumberColor = "#6750A4"
                    )
                }
                _callHistory.value = fastEntries
                _isLoading.value = false
                _hasLoadedFromCache.value = true

                // Enrich with contact names and provider labels on IO thread
                val enrichedEntries = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    var remainingUnseen = unseenCount
                    entries.map { entry ->
                        val isUnseen = remainingUnseen > 0 &&
                            (entry.callType == CallType.MISSED || entry.callType == CallType.BLOCKED)
                        if (isUnseen) remainingUnseen--

                        val providerNum = entry.providerNumber
                        val providerInfo = if (providerNum != null) {
                            providerNumberDao.getByNumber(providerNum)
                        } else null

                        CallHistoryUiEntry(
                            entry = entry,
                            contactName = contactResolver.resolveContactName(entry.phoneNumber),
                            isUnseen = isUnseen,
                            providerNumberLabel = providerInfo?.label ?: providerNum,
                            providerNumberColor = providerInfo?.color ?: "#6750A4"
                        )
                    }
                }
                _callHistory.value = enrichedEntries
            }
        }
    }

    /**
     * Observe WebSocket events for call_history_update to keep data current.
     * When the server updates a call (e.g. INCOMING → MISSED), this triggers
     * a re-sync so the local Room database reflects the latest state.
     */
    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            syncManager.events.collect { event ->
                when (event.type) {
                    "call_history_update" -> {
                        val data = event.data?.jsonObject ?: return@collect
                        val id = data["id"]?.jsonPrimitive?.content ?: return@collect
                        val phoneNumber = data["phone_number"]?.jsonPrimitive?.content ?: return@collect
                        val callType = data["call_type"]?.jsonPrimitive?.content ?: return@collect
                        val timestamp = data["timestamp"]?.jsonPrimitive?.content
                        val providerNumber = data["vonage_number"]?.jsonPrimitive?.contentOrNull
                            ?: data["provider_number"]?.jsonPrimitive?.contentOrNull
                        val durationSeconds = data["duration_seconds"]?.jsonPrimitive?.intOrNull
                        val answeredByDevice = data["answered_by_device"]?.jsonPrimitive?.contentOrNull

                        // If the server says MISSED but the user declined this call,
                        // override to DECLINED to prevent reverting the local classification.
                        val resolvedCallType = if (callType.uppercase() == "MISSED" &&
                            (voiceCallManager.wasCallDeclined(id) ||
                                voiceCallManager.wasRecentCallDeclinedFrom(phoneNumber))
                        ) {
                            CallType.DECLINED
                        } else {
                            parseCallType(callType)
                        }

                        val entry = CallHistoryEntry(
                            id = id,
                            phoneNumber = phoneNumber,
                            providerNumber = providerNumber,
                            callType = resolvedCallType,
                            timestamp = parseTimestamp(timestamp ?: ""),
                            durationSeconds = durationSeconds,
                            answeredByDevice = answeredByDevice
                        )
                        callHistoryDao.insert(entry)
                        Log.d(TAG, "Updated call history entry from WebSocket: $id ($resolvedCallType)")
                    }
                    "blocked_call" -> {
                        // A call was blocked — sync from server to get the entry
                        Log.d(TAG, "Received blocked_call event, syncing from server")
                        syncFromServer()
                    }
                    "connected" -> {
                        // WebSocket reconnected — refresh call history
                        syncFromServer()
                    }
                }
            }
        }
    }

    /**
     * Fetch call history from the server and persist to local database.
     */
    fun syncFromServer() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null
            try {
                val response = callsApi.getCallHistory(page = 1, pageSize = 50)
                response.entries.forEach { dto ->
                    // Override server MISSED with DECLINED for calls the user declined
                    val resolvedType = if (dto.callType.uppercase() == "MISSED" &&
                        (voiceCallManager.wasCallDeclined(dto.id) ||
                            voiceCallManager.wasRecentCallDeclinedFrom(dto.phoneNumber))
                    ) {
                        CallType.DECLINED
                    } else {
                        parseCallType(dto.callType)
                    }
                    val entity = CallHistoryEntry(
                        id = dto.id,
                        phoneNumber = dto.phoneNumber,
                        providerNumber = dto.providerNumber,
                        callType = resolvedType,
                        timestamp = parseTimestamp(dto.timestamp),
                        durationSeconds = dto.durationSeconds,
                        answeredByDevice = dto.answeredByDevice,
                        realCallerNumber = dto.realCallerNumber
                    )
                    callHistoryDao.insert(entity)
                }
                Log.d(TAG, "Synced ${response.entries.size} call history entries from server")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to sync call history from server", e)
                _error.value = "Failed to load call history"
            } finally {
                _isLoading.value = false
            }
        }
    }

    private fun CallHistoryDto.toEntity(): CallHistoryEntry {
        return CallHistoryEntry(
            id = id,
            phoneNumber = phoneNumber,
            providerNumber = providerNumber,
            callType = parseCallType(callType),
            timestamp = parseTimestamp(timestamp),
            durationSeconds = durationSeconds,
            answeredByDevice = answeredByDevice
        )
    }

    private fun parseCallType(type: String): CallType {
        return when (type.uppercase()) {
            "INCOMING" -> CallType.INCOMING
            "OUTGOING" -> CallType.OUTGOING
            "MISSED" -> CallType.MISSED
            "UNANSWERED" -> CallType.UNANSWERED
            "DECLINED" -> CallType.DECLINED
            "BLOCKED" -> CallType.BLOCKED
            else -> CallType.INCOMING
        }
    }

    private fun parseTimestamp(timestamp: String): Long {
        return try {
            Instant.parse(timestamp).toEpochMilli()
        } catch (e: Exception) {
            try {
                timestamp.toLong()
            } catch (e2: Exception) {
                System.currentTimeMillis()
            }
        }
    }
}
