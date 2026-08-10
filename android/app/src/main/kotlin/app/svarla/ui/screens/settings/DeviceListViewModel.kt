package app.svarla.ui.screens.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.svarla.data.remote.AuthManager
import app.svarla.data.remote.api.DevicesApi
import app.svarla.data.remote.dto.DeviceDto
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class DeviceListUiState(
    val devices: List<DeviceDto> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val currentDeviceId: String? = null,
    val showDeregisterDialog: DeviceDto? = null,
    val isDeregistering: Boolean = false,
    val snackbarMessage: String? = null
)

@HiltViewModel
class DeviceListViewModel @Inject constructor(
    private val devicesApi: DevicesApi,
    private val authManager: AuthManager
) : ViewModel() {

    private val _uiState = MutableStateFlow(DeviceListUiState())
    val uiState: StateFlow<DeviceListUiState> = _uiState.asStateFlow()

    init {
        _uiState.update { it.copy(currentDeviceId = getCurrentDeviceId()) }
        loadDevices()
    }

    fun loadDevices() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            try {
                val response = devicesApi.getDevices()
                _uiState.update {
                    it.copy(
                        devices = response.devices,
                        isLoading = false,
                        error = null
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        error = e.message ?: "Failed to load devices"
                    )
                }
            }
        }
    }

    fun showDeregisterConfirmation(device: DeviceDto) {
        _uiState.update { it.copy(showDeregisterDialog = device) }
    }

    fun dismissDeregisterDialog() {
        _uiState.update { it.copy(showDeregisterDialog = null) }
    }

    fun confirmDeregister() {
        val device = _uiState.value.showDeregisterDialog ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(isDeregistering = true, showDeregisterDialog = null) }
            try {
                val success = devicesApi.deleteDevice(device.deviceId)
                if (success) {
                    _uiState.update {
                        it.copy(
                            isDeregistering = false,
                            snackbarMessage = "${device.deviceName} has been deregistered"
                        )
                    }
                    loadDevices()
                } else {
                    _uiState.update {
                        it.copy(
                            isDeregistering = false,
                            error = "Failed to deregister device"
                        )
                    }
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isDeregistering = false,
                        error = e.message ?: "Failed to deregister device"
                    )
                }
            }
        }
    }

    fun clearSnackbarMessage() {
        _uiState.update { it.copy(snackbarMessage = null) }
    }

    private fun getCurrentDeviceId(): String? {
        return authManager.getDeviceId()
    }
}
