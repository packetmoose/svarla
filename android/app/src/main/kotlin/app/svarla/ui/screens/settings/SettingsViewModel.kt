package app.svarla.ui.screens.settings

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.svarla.data.local.dao.ProviderNumberDao
import app.svarla.data.local.entity.ProviderNumber
import app.svarla.data.remote.AuthManager
import app.svarla.data.remote.api.NumbersApi
import app.svarla.data.remote.dto.UpdateBlockInboundRequest
import app.svarla.data.remote.dto.UpdateLabelRequest
import app.svarla.domain.notifications.BatteryOptimizationHelper
import app.svarla.domain.notifications.NotificationDeliveryMode
import app.svarla.domain.notifications.NotificationDeliveryPreferences
import app.svarla.domain.notifications.PushEndpointManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val numbersApi: NumbersApi,
    private val providerNumberDao: ProviderNumberDao,
    private val authManager: AuthManager,
    private val deliveryPreferences: NotificationDeliveryPreferences,
    private val pushEndpointManager: PushEndpointManager,
    val batteryOptimizationHelper: BatteryOptimizationHelper
) : ViewModel() {

    private val _numbers = MutableStateFlow<List<ProviderNumber>>(emptyList())
    val numbers: StateFlow<List<ProviderNumber>> = _numbers.asStateFlow()

    private val _defaultNumber = MutableStateFlow<String?>(null)
    val defaultNumber: StateFlow<String?> = _defaultNumber.asStateFlow()

    private val _isLoggingOut = MutableStateFlow(false)
    val isLoggingOut: StateFlow<Boolean> = _isLoggingOut.asStateFlow()

    private val _deliveryMode = MutableStateFlow(deliveryPreferences.getStoredMode())
    val deliveryMode: StateFlow<NotificationDeliveryMode> = _deliveryMode.asStateFlow()

    private val _isUnifiedPushAvailable = MutableStateFlow(false)
    val isUnifiedPushAvailable: StateFlow<Boolean> = _isUnifiedPushAvailable.asStateFlow()

    init {
        loadNumbers()
        checkUnifiedPushAvailability()
    }

    private fun checkUnifiedPushAvailability() {
        _isUnifiedPushAvailable.value = pushEndpointManager.isUnifiedPushAvailable()
    }

    fun setDeliveryMode(mode: NotificationDeliveryMode) {
        deliveryPreferences.setMode(mode)
        _deliveryMode.value = mode
    }

    fun isIgnoringBatteryOptimizations(): Boolean {
        return batteryOptimizationHelper.isIgnoringBatteryOptimizations()
    }

    init {
        loadNumbers()
    }

    private fun loadNumbers() {
        viewModelScope.launch {
            // Sync from server
            try {
                val response = numbersApi.getNumbers()
                _defaultNumber.value = response.defaultNumber
                response.numbers.forEach { dto ->
                    val isDefault = dto.number == response.defaultNumber
                    providerNumberDao.insert(
                        ProviderNumber(
                            number = dto.number,
                            label = dto.label,
                            color = dto.color,
                            isActive = dto.isActive,
                            lastUsedAt = dto.lastUsedAt?.toLongOrNull(),
                            blockInboundCalls = dto.blockInboundCalls,
                            isDefault = isDefault
                        )
                    )
                }
            } catch (e: Exception) {
                Log.w("SettingsVM", "Failed to sync numbers", e)
            }

            // Observe local DB
            providerNumberDao.getAll().collect { numbers ->
                _numbers.value = numbers
            }
        }
    }

    fun setDefaultNumber(number: String) {
        viewModelScope.launch {
            try {
                numbersApi.setDefaultNumber(
                    app.svarla.data.remote.dto.SetDefaultNumberRequest(number = number)
                )
                // Update local DB
                providerNumberDao.clearAllDefaults()
                val existing = providerNumberDao.getByNumber(number)
                existing?.let {
                    providerNumberDao.update(it.copy(isDefault = true))
                }
                _defaultNumber.value = number
            } catch (e: Exception) {
                Log.e("SettingsVM", "Failed to set default number", e)
            }
        }
    }

    fun clearDefaultNumber() {
        viewModelScope.launch {
            try {
                numbersApi.setDefaultNumber(
                    app.svarla.data.remote.dto.SetDefaultNumberRequest(number = null)
                )
                providerNumberDao.clearAllDefaults()
                _defaultNumber.value = null
            } catch (e: Exception) {
                Log.e("SettingsVM", "Failed to clear default number", e)
            }
        }
    }

    fun updateLabel(number: String, label: String) {
        viewModelScope.launch {
            try {
                numbersApi.updateLabel(number, UpdateLabelRequest(label))
                // Update local DB
                val existing = providerNumberDao.getByNumber(number)
                if (existing != null) {
                    providerNumberDao.insert(existing.copy(label = label))
                }
            } catch (e: Exception) {
                Log.e("SettingsVM", "Failed to update label for $number", e)
            }
        }
    }

    fun toggleBlockInbound(number: String) {
        viewModelScope.launch {
            try {
                val existing = providerNumberDao.getByNumber(number) ?: return@launch
                val newValue = !existing.blockInboundCalls
                numbersApi.updateBlockInbound(number, UpdateBlockInboundRequest(block = newValue))
                providerNumberDao.update(existing.copy(blockInboundCalls = newValue))
            } catch (e: Exception) {
                Log.e("SettingsVM", "Failed to toggle block inbound for $number", e)
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            _isLoggingOut.value = true
            try {
                authManager.logout()
            } catch (e: Exception) {
                Log.e("SettingsVM", "Logout failed", e)
            } finally {
                _isLoggingOut.value = false
            }
        }
    }
}
