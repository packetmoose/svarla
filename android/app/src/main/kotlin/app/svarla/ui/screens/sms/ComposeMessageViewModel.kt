package app.svarla.ui.screens.sms

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.svarla.data.local.dao.ProviderNumberDao
import app.svarla.data.local.entity.ProviderNumber
import app.svarla.data.remote.api.NumbersApi
import app.svarla.domain.contacts.ContactInfo
import app.svarla.domain.contacts.ContactResolver
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * UI state for the compose message screen.
 */
data class ComposeMessageUiState(
    val selectedProviderNumber: ProviderNumber? = null,
    val availableNumbers: List<ProviderNumber> = emptyList()
)

/**
 * ViewModel for the new conversation creation screen.
 *
 * Handles:
 * - Provider number selection for sender ("from" number)
 * - Contact search for selecting the destination
 *
 * Requirements covered: 3.1, 3.4, 3.5, 3.7
 */
@HiltViewModel
class ComposeMessageViewModel @Inject constructor(
    private val providerNumberDao: ProviderNumberDao,
    private val numbersApi: NumbersApi,
    private val contactResolver: ContactResolver
) : ViewModel() {

    private val _uiState = MutableStateFlow(ComposeMessageUiState())
    val uiState: StateFlow<ComposeMessageUiState> = _uiState.asStateFlow()

    init {
        loadProviderNumbers()
    }

    fun onProviderNumberSelected(providerNumber: ProviderNumber) {
        _uiState.update { it.copy(selectedProviderNumber = providerNumber) }
    }

    /**
     * Search contacts by name or number.
     * Returns up to 20 results.
     */
    fun searchContacts(query: String): List<ContactInfo> {
        if (query.length < 2) return emptyList()
        return contactResolver.searchContacts(query)
    }

    /**
     * Normalizes a phone number using the selected provider number's country prefix.
     * Converts local numbers (e.g. 070...) to E.164 (e.g. +4670...).
     * If already E.164 or no provider number selected, returns as-is.
     */
    fun normalizeNumber(phoneNumber: String): String {
        val providerNumber = _uiState.value.selectedProviderNumber?.number ?: return phoneNumber
        if (phoneNumber.startsWith("+")) return phoneNumber
        if (!providerNumber.startsWith("+") || providerNumber.length < 4) return phoneNumber

        // Extract country prefix from the provider number
        val digits = providerNumber.substring(1)
        val countryCode = when {
            digits[0] == '1' || digits[0] == '7' -> digits.substring(0, 1)
            digits.length >= 2 && digits.substring(0, 2).toIntOrNull()?.let { it in 20..69 } == true -> digits.substring(0, 2)
            digits.length >= 3 -> digits.substring(0, 3)
            else -> return phoneNumber
        }

        // Replace leading 0 with country prefix
        return if (phoneNumber.startsWith("0") && phoneNumber.length > 1) {
            "+$countryCode${phoneNumber.substring(1)}"
        } else {
            phoneNumber
        }
    }

    // ========================================================================
    // Private implementation
    // ========================================================================

    private fun loadProviderNumbers() {
        // First, fetch numbers from server and populate Room
        viewModelScope.launch {
            try {
                val response = numbersApi.getNumbers()
                val activeNumbers = mutableListOf<String>()
                response.numbers.forEach { dto ->
                    activeNumbers.add(dto.number)
                    val entity = ProviderNumber(
                        number = dto.number,
                        label = dto.label,
                        color = dto.color,
                        isActive = dto.isActive,
                        lastUsedAt = dto.lastUsedAt?.toLongOrNull(),
                        blockInboundCalls = dto.blockInboundCalls,
                        isDefault = dto.number == response.defaultNumber
                    )
                    providerNumberDao.insert(entity)
                }
                // Deactivate numbers no longer on server
                if (activeNumbers.isNotEmpty()) {
                    providerNumberDao.deactivateExcept(activeNumbers)
                }
            } catch (e: Exception) {
                Log.w("ComposeMessageVM", "Failed to sync numbers from server", e)
            }
        }
        // Then observe Room for reactive updates
        viewModelScope.launch {
            providerNumberDao.getActive().collect { numbers ->
                _uiState.update { state ->
                    val selected = state.selectedProviderNumber
                        ?: selectDefaultNumber(numbers)
                    state.copy(
                        availableNumbers = numbers,
                        selectedProviderNumber = selected
                    )
                }
            }
        }
    }

    /**
     * Select the default provider number: user-set default first, then most recently used, or the first available.
     * If only one number exists, auto-select it.
     */
    private fun selectDefaultNumber(numbers: List<ProviderNumber>): ProviderNumber? {
        if (numbers.isEmpty()) return null
        if (numbers.size == 1) return numbers.first()

        // Check for user-set default
        val userDefault = numbers.find { it.isDefault }
        if (userDefault != null) return userDefault

        // Select most recently used number
        return numbers.maxByOrNull { it.lastUsedAt ?: 0L } ?: numbers.first()
    }
}
