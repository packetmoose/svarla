package app.svarla.ui.screens.conversations

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.svarla.data.remote.api.ReadStateApi
import app.svarla.data.repository.ConversationRepository
import app.svarla.domain.contacts.ContactResolver
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

data class ConversationListUiState(
    val conversations: List<ConversationListItem> = emptyList(),
    val isLoading: Boolean = false,
    val hasLoadedFromCache: Boolean = false,
    val error: String? = null
)

data class ConversationListItem(
    val phoneNumber: String,
    val providerNumber: String,
    val displayName: String,
    val preview: String,
    val timestamp: Long?,
    val providerNumberLabel: String,
    val providerNumberColor: String = "#6750A4",
    val unreadCount: Int = 0
)

@HiltViewModel
class ConversationListViewModel @Inject constructor(
    private val conversationRepository: ConversationRepository,
    private val contactResolver: ContactResolver,
    private val readStateApi: ReadStateApi
) : ViewModel() {

    private val _uiState = MutableStateFlow(ConversationListUiState())
    val uiState: StateFlow<ConversationListUiState> = _uiState.asStateFlow()

    init {
        observeConversations()
        syncFromServer()
    }

    private fun observeConversations() {
        viewModelScope.launch {
            conversationRepository.observeConversations()
                .catch { e ->
                    _uiState.update { it.copy(error = e.message, isLoading = false, hasLoadedFromCache = true) }
                }
                .collect { conversations ->
                    // Emit immediately with raw data — no DB queries or content provider calls.
                    // This ensures cached Room data renders in the very first frame.
                    val fastItems = conversations.map { conv ->
                        val isUnread = conv.lastReceivedAt != null &&
                            (conv.lastReadAt == null || conv.lastReceivedAt > conv.lastReadAt)
                        ConversationListItem(
                            phoneNumber = conv.phoneNumber,
                            providerNumber = conv.providerNumber,
                            displayName = conv.phoneNumber,
                            preview = conv.lastMessagePreview?.take(50) ?: "",
                            timestamp = conv.lastMessageTimestamp,
                            providerNumberLabel = "",
                            providerNumberColor = "#6750A4",
                            unreadCount = if (isUnread) 1 else 0
                        )
                    }
                    _uiState.update {
                        it.copy(conversations = fastItems, isLoading = false, error = null, hasLoadedFromCache = true)
                    }

                    // Enrich with contact names and provider labels off-main-thread
                    val enrichedItems = withContext(Dispatchers.IO) {
                        conversations.map { conv ->
                            val providerLabel = if (conv.providerNumber.isNotEmpty()) {
                                conversationRepository.getProviderNumberLabel(conv.providerNumber)
                            } else {
                                conversationRepository.getProviderNumberLabelForConversation(conv.phoneNumber)
                            }
                            val providerColor = if (conv.providerNumber.isNotEmpty()) {
                                conversationRepository.getProviderNumberColor(conv.providerNumber)
                            } else {
                                "#6750A4"
                            }
                            val isUnread = conv.lastReceivedAt != null &&
                                (conv.lastReadAt == null || conv.lastReceivedAt > conv.lastReadAt)
                            ConversationListItem(
                                phoneNumber = conv.phoneNumber,
                                providerNumber = conv.providerNumber,
                                displayName = contactResolver.resolveContactName(conv.phoneNumber) ?: conv.phoneNumber,
                                preview = conv.lastMessagePreview?.take(50) ?: "",
                                timestamp = conv.lastMessageTimestamp,
                                providerNumberLabel = providerLabel,
                                providerNumberColor = providerColor,
                                unreadCount = if (isUnread) 1 else 0
                            )
                        }
                    }
                    _uiState.update {
                        it.copy(conversations = enrichedItems)
                    }
                }
        }
    }

    fun syncFromServer() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            try {
                conversationRepository.syncConversations()
            } catch (e: Exception) {
                _uiState.update { it.copy(error = e.message) }
            } finally {
                _uiState.update { it.copy(isLoading = false) }
            }
        }
    }

    /**
     * Remove a conversation from the list.
     * Marks it as removed locally and on the server.
     */
    fun removeConversation(providerNumber: String, phoneNumber: String) {
        viewModelScope.launch {
            try {
                conversationRepository.removeConversation(providerNumber, phoneNumber)
            } catch (e: Exception) {
                _uiState.update { it.copy(error = "Failed to remove conversation") }
            }
        }
    }
}
