package app.svarla.ui.screens.numbers

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.svarla.data.local.dao.ProviderNumberDao
import app.svarla.data.local.entity.ProviderNumber
import app.svarla.data.remote.api.NumbersApi
import app.svarla.data.remote.dto.UpdateBlockInboundRequest
import app.svarla.data.remote.dto.UpdateLabelRequest
import app.svarla.data.remote.dto.WebSocketEvent
import app.svarla.data.remote.sync.SyncManager
import app.svarla.ui.components.NumberInUseStatus
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

/**
 * UI state for a single number item in edit mode.
 */
data class NumberEditState(
    val number: String,
    val editingLabel: String = "",
    val isEditing: Boolean = false,
    val isSaving: Boolean = false,
    val error: String? = null
)

/**
 * UI state for the Number Management screen.
 */
data class NumberManagementUiState(
    val numbers: List<ProviderNumber> = emptyList(),
    val editStates: Map<String, NumberEditState> = emptyMap(),
    val inUseStatuses: Map<String, NumberInUseStatus> = emptyMap(),
    val isLoading: Boolean = true,
    val isSyncing: Boolean = false,
    val syncError: String? = null
)

/**
 * ViewModel for the Number Management screen.
 *
 * Handles:
 * - Loading all provider numbers with labels from local cache
 * - Inline label editing with 1-30 character validation
 * - Syncing with backend to persist label changes
 * - Tracking in-use status from WebSocket call_event data
 * - Triggering number sync from provider API
 *
 * Requirements covered: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.9
 */
@HiltViewModel
class NumberManagementViewModel @Inject constructor(
    private val numbersApi: NumbersApi,
    private val providerNumberDao: ProviderNumberDao,
    private val syncManager: SyncManager
) : ViewModel() {

    companion object {
        private const val TAG = "NumberManagementVM"
        private const val MIN_LABEL_LENGTH = 1
        private const val MAX_LABEL_LENGTH = 30
    }

    private val _uiState = MutableStateFlow(NumberManagementUiState())
    val uiState: StateFlow<NumberManagementUiState> = _uiState.asStateFlow()

    init {
        loadNumbers()
        observeWebSocketEvents()
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Start editing the label for a specific number.
     */
    fun startEditing(number: String) {
        val currentNumber = _uiState.value.numbers.find { it.number == number }
        _uiState.update { state ->
            val editState = NumberEditState(
                number = number,
                editingLabel = currentNumber?.label ?: "",
                isEditing = true
            )
            state.copy(
                editStates = state.editStates + (number to editState)
            )
        }
    }

    /**
     * Cancel editing for a specific number.
     */
    fun cancelEditing(number: String) {
        _uiState.update { state ->
            state.copy(
                editStates = state.editStates - number
            )
        }
    }

    /**
     * Update the label being edited (in-memory only, not yet saved).
     */
    fun onLabelChanged(number: String, newLabel: String) {
        // Enforce max length
        val trimmedLabel = if (newLabel.length > MAX_LABEL_LENGTH) {
            newLabel.take(MAX_LABEL_LENGTH)
        } else {
            newLabel
        }

        _uiState.update { state ->
            val editState = state.editStates[number]?.copy(
                editingLabel = trimmedLabel,
                error = null
            ) ?: return
            state.copy(
                editStates = state.editStates + (number to editState)
            )
        }
    }

    /**
     * Save the edited label to the backend.
     */
    fun saveLabel(number: String) {
        val editState = _uiState.value.editStates[number] ?: return
        val label = editState.editingLabel.trim()

        // Validate label length
        if (label.isNotEmpty() && (label.length < MIN_LABEL_LENGTH || label.length > MAX_LABEL_LENGTH)) {
            _uiState.update { state ->
                val updated = editState.copy(error = "Label must be 1-30 characters")
                state.copy(editStates = state.editStates + (number to updated))
            }
            return
        }

        _uiState.update { state ->
            val updated = editState.copy(isSaving = true, error = null)
            state.copy(editStates = state.editStates + (number to updated))
        }

        viewModelScope.launch {
            try {
                if (label.isEmpty()) {
                    // Empty label means clear it — send empty or handle as null
                    numbersApi.updateLabel(number, UpdateLabelRequest(label = ""))
                    // Update local DB
                    val existing = providerNumberDao.getByNumber(number)
                    existing?.let {
                        providerNumberDao.update(it.copy(label = null))
                    }
                } else {
                    numbersApi.updateLabel(number, UpdateLabelRequest(label = label))
                    // Update local DB
                    val existing = providerNumberDao.getByNumber(number)
                    existing?.let {
                        providerNumberDao.update(it.copy(label = label))
                    }
                }

                // Done editing
                _uiState.update { state ->
                    state.copy(editStates = state.editStates - number)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to update label for $number", e)
                _uiState.update { state ->
                    val updated = editState.copy(
                        isSaving = false,
                        error = "Failed to save label. Please try again."
                    )
                    state.copy(editStates = state.editStates + (number to updated))
                }
            }
        }
    }

    /**
     * Trigger a sync of numbers from provider API (detects additions/removals).
     */
    fun syncNumbers() {
        _uiState.update { it.copy(isSyncing = true, syncError = null) }

        viewModelScope.launch {
            try {
                val response = numbersApi.syncNumbers()
                // Update local DB with synced numbers
                response.numbers.forEach { dto ->
                    val entity = ProviderNumber(
                        number = dto.number,
                        label = dto.label,
                        color = dto.color,
                        isActive = dto.isActive,
                        lastUsedAt = dto.lastUsedAt?.toLongOrNull(),
                        blockInboundCalls = dto.blockInboundCalls
                    )
                    providerNumberDao.insert(entity)
                }
                _uiState.update { it.copy(isSyncing = false) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to sync numbers", e)
                _uiState.update {
                    it.copy(
                        isSyncing = false,
                        syncError = "Failed to sync numbers."
                    )
                }
            }
        }
    }

    /**
     * Dismiss the sync error.
     */
    fun dismissSyncError() {
        _uiState.update { it.copy(syncError = null) }
    }

    /**
     * Toggle the block incoming calls setting for a specific number.
     */
    fun toggleBlockInbound(number: String) {
        val currentNumber = _uiState.value.numbers.find { it.number == number } ?: return
        val newValue = !currentNumber.blockInboundCalls

        viewModelScope.launch {
            try {
                numbersApi.updateBlockInbound(number, UpdateBlockInboundRequest(block = newValue))
                // Update local DB
                val existing = providerNumberDao.getByNumber(number)
                existing?.let {
                    providerNumberDao.update(it.copy(blockInboundCalls = newValue))
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to update block inbound calls for $number", e)
                _uiState.update {
                    it.copy(syncError = "Failed to update block incoming calls setting.")
                }
            }
        }
    }

    // ========================================================================
    // Private implementation
    // ========================================================================

    private fun loadNumbers() {
        viewModelScope.launch {
            providerNumberDao.getAll().collect { numbers ->
                _uiState.update { state ->
                    state.copy(
                        numbers = numbers,
                        isLoading = false
                    )
                }
            }
        }
    }

    /**
     * Observe WebSocket events for call_event to track in-use status of numbers.
     * When a call_event indicates a number is in use on another device, update the state.
     */
    private fun observeWebSocketEvents() {
        viewModelScope.launch {
            syncManager.events.collect { event ->
                handleWebSocketEvent(event)
            }
        }
    }

    private fun handleWebSocketEvent(event: WebSocketEvent) {
        when (event.type) {
            "call_event" -> {
                val data = event.data?.jsonObject ?: return
                val status = data["status"]?.jsonPrimitive?.content ?: return
                val providerNumber = data["providerNumber"]?.jsonPrimitive?.content
                    ?: data["vonageNumber"]?.jsonPrimitive?.content ?: return
                val deviceName = data["deviceName"]?.jsonPrimitive?.content ?: "another device"

                when (status) {
                    "connected", "ringing" -> {
                        // Number is now in use on another device
                        _uiState.update { state ->
                            state.copy(
                                inUseStatuses = state.inUseStatuses + (providerNumber to NumberInUseStatus(
                                    number = providerNumber,
                                    deviceName = deviceName
                                ))
                            )
                        }
                    }
                    "disconnected", "completed", "failed" -> {
                        // Number is no longer in use
                        _uiState.update { state ->
                            state.copy(
                                inUseStatuses = state.inUseStatuses - providerNumber
                            )
                        }
                    }
                }
            }
            "number_label_updated" -> {
                val data = event.data?.jsonObject ?: return
                val number = data["number"]?.jsonPrimitive?.content ?: return
                val label = data["label"]?.jsonPrimitive?.content

                // Update local DB when another device changes a label
                viewModelScope.launch {
                    val existing = providerNumberDao.getByNumber(number)
                    existing?.let {
                        providerNumberDao.update(it.copy(label = label))
                    }
                }
            }
            "number_block_inbound_updated" -> {
                val data = event.data?.jsonObject ?: return
                val number = data["number"]?.jsonPrimitive?.content ?: return
                val blockInboundCalls = data["blockInboundCalls"]?.jsonPrimitive?.content?.toBoolean() ?: return

                // Update local DB when another device changes the block inbound setting
                viewModelScope.launch {
                    val existing = providerNumberDao.getByNumber(number)
                    existing?.let {
                        providerNumberDao.update(it.copy(blockInboundCalls = blockInboundCalls))
                    }
                }
            }
        }
    }
}
