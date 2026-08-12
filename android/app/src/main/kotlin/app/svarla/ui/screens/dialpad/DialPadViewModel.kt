package app.svarla.ui.screens.dialpad

import android.telephony.PhoneNumberUtils
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.svarla.data.local.dao.CallHistoryDao
import app.svarla.data.local.dao.ProviderNumberDao
import app.svarla.data.local.entity.CallType
import app.svarla.data.local.entity.ProviderNumber
import app.svarla.data.remote.api.CallsApi
import app.svarla.data.remote.api.NumbersApi
import app.svarla.domain.call.VoiceCallManager
import app.svarla.domain.contacts.ContactInfo
import app.svarla.domain.contacts.ContactResolver
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

/**
 * ViewModel for the dial pad screen.
 *
 * Manages the entered number, formatting, contact suggestions,
 * and last dialed number retrieval.
 *
 * Requirements covered: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.13
 */
@HiltViewModel
class DialPadViewModel @Inject constructor(
    private val contactResolver: ContactResolver,
    private val callHistoryDao: CallHistoryDao,
    private val providerNumberDao: ProviderNumberDao,
    private val numbersApi: NumbersApi,
    private val callsApi: CallsApi,
    private val voiceCallManager: VoiceCallManager
) : ViewModel() {

    companion object {
        private const val MAX_SUGGESTIONS = 5
    }

    /** The raw digits/characters entered by the user (unformatted). */
    private val _rawInput = MutableStateFlow("")
    val rawInput: StateFlow<String> = _rawInput.asStateFlow()

    /** The formatted number for display. */
    private val _formattedNumber = MutableStateFlow("")
    val formattedNumber: StateFlow<String> = _formattedNumber.asStateFlow()

    /** Contact suggestions matching the current input. */
    private val _contactSuggestions = MutableStateFlow<List<ContactInfo>>(emptyList())
    val contactSuggestions: StateFlow<List<ContactInfo>> = _contactSuggestions.asStateFlow()

    /** Contact name matching the currently entered complete number. */
    private val _matchedContactName = MutableStateFlow<String?>(null)
    val matchedContactName: StateFlow<String?> = _matchedContactName.asStateFlow()

    /** Whether the last dialed number has been populated (for empty field + call scenario). */
    private val _showingLastDialed = MutableStateFlow(false)
    val showingLastDialed: StateFlow<Boolean> = _showingLastDialed.asStateFlow()

    /** Available provider numbers for outbound calls. */
    private val _availableNumbers = MutableStateFlow<List<ProviderNumber>>(emptyList())
    val availableNumbers: StateFlow<List<ProviderNumber>> = _availableNumbers.asStateFlow()

    /** Currently selected provider number for the outbound call. */
    private val _selectedProviderNumber = MutableStateFlow<ProviderNumber?>(null)
    val selectedProviderNumber: StateFlow<ProviderNumber?> = _selectedProviderNumber.asStateFlow()

    init {
        Log.d("DialPadVM", "init: ViewModel created")
        observeInputForSuggestions()
        loadProviderNumbers()
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Append a digit or symbol to the input.
     *
     * @param char The character to append (0-9, *, #, +)
     */
    fun appendDigit(char: Char) {
        _showingLastDialed.value = false
        val newInput = _rawInput.value + char
        _rawInput.value = newInput
        _formattedNumber.value = formatNumber(newInput)
    }

    /**
     * Remove the last character from the input (backspace).
     */
    fun deleteLastDigit() {
        val current = _rawInput.value
        if (current.isNotEmpty()) {
            val newInput = current.dropLast(1)
            _rawInput.value = newInput
            _formattedNumber.value = formatNumber(newInput)
            _showingLastDialed.value = false
        }
    }

    /**
     * Clear the entire input field.
     */
    fun clearInput() {
        _rawInput.value = ""
        _formattedNumber.value = ""
        _contactSuggestions.value = emptyList()
        _showingLastDialed.value = false
    }

    /**
     * Handle a contact selection from the suggestions list.
     * Populates the input field with the contact's phone number.
     *
     * @param contact The selected contact
     */
    fun selectContact(contact: ContactInfo) {
        _rawInput.value = contact.phoneNumber
        _formattedNumber.value = formatNumber(contact.phoneNumber)
        _contactSuggestions.value = emptyList()
    }

    /**
     * Handle the call button press when the field is empty.
     * Populates with the most recent outbound number from call history.
     *
     * @return true if a last dialed number was found and populated, false otherwise
     */
    fun populateLastDialedNumber(onResult: (Boolean) -> Unit) {
        viewModelScope.launch {
            val lastOutbound = getLastOutboundNumber()
            if (lastOutbound != null) {
                _rawInput.value = lastOutbound
                _formattedNumber.value = formatNumber(lastOutbound)
                _showingLastDialed.value = true
                onResult(true)
            } else {
                onResult(false)
            }
        }
    }

    /**
     * Get the current raw input value for initiating a call or SMS.
     */
    fun getCurrentNumber(): String = _rawInput.value

    // ========================================================================
    // Number formatting
    // ========================================================================

    /**
     * Formats a phone number string for readable display.
     * Uses Android's PhoneNumberUtils for locale-appropriate formatting.
     *
     * Examples:
     * - "+15551234567" → "+1 555 123 4567"
     * - "5551234567" → "555 123 4567"
     *
     * @param input The raw number input
     * @return Formatted number string
     */
    internal fun formatNumber(input: String): String {
        if (input.isEmpty()) return ""

        // Use PhoneNumberUtils for formatting. It handles various numbering plans.
        val formatted = PhoneNumberUtils.formatNumber(
            input,
            java.util.Locale.getDefault().country
        )

        // If PhoneNumberUtils returns null (unrecognized format), return input as-is
        return formatted ?: input
    }

    // ========================================================================
    // Contact suggestions
    // ========================================================================

    @OptIn(FlowPreview::class)
    private fun observeInputForSuggestions() {
        viewModelScope.launch {
            _rawInput
                .debounce(300)
                .distinctUntilChanged()
                .collect { input ->
                    if (input.length >= 7) {
                        // Look for an exact contact match for complete numbers
                        resolveContactForNumber(input)
                    } else {
                        _matchedContactName.value = null
                        _contactSuggestions.value = emptyList()
                    }
                }
        }
    }

    private suspend fun resolveContactForNumber(number: String) {
        withContext(Dispatchers.IO) {
            val name = contactResolver.resolveContactName(number)
            _matchedContactName.value = name
            _contactSuggestions.value = emptyList()
        }
    }

    /**
     * Search contacts by name or number for the contact search overlay.
     * Returns up to [MAX_SUGGESTIONS] results.
     */
    fun searchContactsForOverlay(query: String): List<ContactInfo> {
        if (query.length < 2) return emptyList()
        return contactResolver.searchContacts(query).take(MAX_SUGGESTIONS)
    }

    // ========================================================================
    // Call history lookup
    // ========================================================================

    /**
     * Retrieves the most recent outbound (OUTGOING or UNANSWERED) phone number
     * from the call history.
     */
    private suspend fun getLastOutboundNumber(): String? {
        return withContext(Dispatchers.IO) {
            try {
                val recentCalls = callHistoryDao.getRecent(50).first()
                recentCalls.firstOrNull { entry ->
                    entry.callType == CallType.OUTGOING || entry.callType == CallType.UNANSWERED
                }?.phoneNumber
            } catch (e: Exception) {
                null
            }
        }
    }

    // ========================================================================
    // Provider number selection
    // ========================================================================

    /**
     * Select a provider number for the outbound call.
     */
    fun selectProviderNumber(number: ProviderNumber) {
        _selectedProviderNumber.value = number
    }

    /**
     * Get the currently selected provider number for initiating a call.
     */
    fun getSelectedProviderNumber(): ProviderNumber? = _selectedProviderNumber.value

    /** Call state for UI feedback */
    private val _callError = MutableStateFlow<String?>(null)
    val callError: StateFlow<String?> = _callError.asStateFlow()

    /**
     * Initiate an outbound call via the provider.
     */
    fun makeCall(to: String) {
        val fromNumber = _selectedProviderNumber.value?.number
        if (fromNumber == null) {
            _callError.value = "No number selected"
            return
        }
        if (to.isBlank()) {
            _callError.value = "Enter a number to call"
            return
        }

        _callError.value = null
        // Use VoiceCallManager to initiate the call via the provider
        // This transitions callState from IDLE → DIALING and establishes the WebRTC session
        voiceCallManager.makeCall(from = fromNumber, to = to)
    }

    private fun loadProviderNumbers() {
        // Observe Room immediately — cached numbers render on the first frame
        Log.d("DialPadVM", "loadProviderNumbers: starting Room observation")
        viewModelScope.launch {
            providerNumberDao.getActive().collect { numbers ->
                Log.d("DialPadVM", "loadProviderNumbers: Room emitted ${numbers.size} numbers")
                _availableNumbers.value = numbers
                if (_selectedProviderNumber.value == null ||
                    numbers.none { it.number == _selectedProviderNumber.value?.number }
                ) {
                    _selectedProviderNumber.value = selectDefaultNumber(numbers)
                    Log.d("DialPadVM", "loadProviderNumbers: selected default = ${_selectedProviderNumber.value?.number}")
                }
            }
        }
        // Sync from server in the background — Room observation picks up changes automatically
        viewModelScope.launch {
            Log.d("DialPadVM", "loadProviderNumbers: starting server sync")
            try {
                val response = numbersApi.getNumbers()
                Log.d("DialPadVM", "loadProviderNumbers: server returned ${response.numbers.size} numbers")
                val activeNumbers = mutableListOf<String>()
                response.numbers.forEach { dto ->
                    activeNumbers.add(dto.number)
                }
                // Batch insert all numbers, then deactivate — minimizes Room Flow re-emissions
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    val entities = response.numbers.map { dto ->
                        ProviderNumber(
                            number = dto.number,
                            label = dto.label,
                            color = dto.color,
                            isActive = dto.isActive,
                            lastUsedAt = dto.lastUsedAt?.toLongOrNull(),
                            blockInboundCalls = dto.blockInboundCalls,
                            isDefault = dto.number == response.defaultNumber
                        )
                    }
                    providerNumberDao.insertAll(entities)
                    if (activeNumbers.isNotEmpty()) {
                        providerNumberDao.deactivateExcept(activeNumbers)
                    }
                }
                Log.d("DialPadVM", "loadProviderNumbers: server sync complete")
            } catch (e: Exception) {
                Log.w("DialPadVM", "Failed to sync numbers from server", e)
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
