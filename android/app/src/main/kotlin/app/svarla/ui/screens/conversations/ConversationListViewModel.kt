package app.svarla.ui.screens.conversations

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.svarla.data.local.dao.MessageDao
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
    val isLoading: Boolean = true,
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
    val unreadCount: Int = 0,
    val photoUri: String? = null
)

@HiltViewModel
class ConversationListViewModel @Inject constructor(
    private val conversationRepository: ConversationRepository,
    private val contactResolver: ContactResolver,
    private val readStateApi: ReadStateApi,
    private val messageDao: MessageDao
) : ViewModel() {

    companion object {
        private const val TAG = "ConversationListVM"
    }

    private val _uiState = MutableStateFlow(ConversationListUiState())
    val uiState: StateFlow<ConversationListUiState> = _uiState.asStateFlow()

    init {
        Log.d(TAG, "init: ViewModel created")
        observeConversations()
        syncFromServer()
    }

    private fun observeConversations() {
        viewModelScope.launch {
            Log.d(TAG, "observeConversations: starting Room observation")
            conversationRepository.observeConversations()
                .catch { e ->
                    Log.e(TAG, "observeConversations: error", e)
                    _uiState.update { it.copy(error = e.message, isLoading = false, hasLoadedFromCache = true) }
                }
                .collect { conversations ->
                    Log.d(TAG, "observeConversations: Room emitted ${conversations.size} conversations, starting enrichment")
                    val startTime = System.currentTimeMillis()
                    // Enrich with contact names and provider labels in a single pass.
                    // We avoid a two-phase emit (raw then enriched) because that causes
                    // visible layout shifts when provider labels appear/disappear.
                    // Room queries and the contact cache are local, so this is fast.
                    val enrichedItems = withContext(Dispatchers.IO) {
                        // Batch resolve all contact names in one pass (one lookup per unique number)
                        val phoneNumbers = conversations.map { it.phoneNumber }.toSet()
                        val contactResolveStart = System.currentTimeMillis()
                        val contactNames = contactResolver.resolveContactNames(phoneNumbers)
                        val contactPhotoUris = contactResolver.resolveContactPhotoUris(phoneNumbers)
                        Log.d(TAG, "observeConversations: contact resolve took ${System.currentTimeMillis() - contactResolveStart}ms for ${phoneNumbers.size} numbers (${contactNames.size} resolved)")

                        // Batch resolve unread message counts per conversation thread.
                        // Keyed by the full (providerNumber, phoneNumber) pair so that two
                        // conversations with the same recipient but different provider numbers
                        // are tracked independently.
                        val unreadCounts = messageDao.getUnreadCountsPerConversation()
                        val unreadCountMap = unreadCounts.associate {
                            (it.providerNumber to it.conversationNumber) to it.count
                        }

                        // Batch resolve all provider numbers in a single query
                        val providerResolveStart = System.currentTimeMillis()
                        val uniqueProviderNumbers = conversations.map { it.providerNumber }.filter { it.isNotEmpty() }.toSet()
                        val providerInfoList = if (uniqueProviderNumbers.isNotEmpty()) {
                            conversationRepository.getProviderNumbersByNumbers(uniqueProviderNumbers.toList())
                        } else emptyList()
                        val providerInfoMap = providerInfoList.associateBy { it.number }

                        val result = conversations.map { conv ->
                            val providerInfo = if (conv.providerNumber.isNotEmpty()) {
                                providerInfoMap[conv.providerNumber]
                            } else null
                            val providerLabel = providerInfo?.label ?: conv.providerNumber.ifEmpty { "" }
                            val providerColor = providerInfo?.color ?: "#6750A4"
                            // Use the DAO count if messages are synced locally, otherwise
                            // fall back to timestamp-based detection (shows 1 if unread)
                            val daoCount = unreadCountMap[conv.providerNumber to conv.phoneNumber] ?: 0
                            val unreadCount = if (daoCount > 0) {
                                daoCount
                            } else {
                                // Fallback: if timestamps indicate unread but no local messages yet
                                val isUnreadByTimestamp = conv.lastReceivedAt != null &&
                                    (conv.lastReadAt == null || conv.lastReceivedAt > conv.lastReadAt)
                                if (isUnreadByTimestamp) 1 else 0
                            }
                            ConversationListItem(
                                phoneNumber = conv.phoneNumber,
                                providerNumber = conv.providerNumber,
                                displayName = contactNames[conv.phoneNumber] ?: conv.phoneNumber,
                                preview = conv.lastMessagePreview?.take(50) ?: "",
                                timestamp = conv.lastMessageTimestamp,
                                providerNumberLabel = providerLabel,
                                providerNumberColor = providerColor,
                                unreadCount = unreadCount,
                                photoUri = contactPhotoUris[conv.phoneNumber]
                            )
                        }
                        Log.d(TAG, "observeConversations: provider resolve took ${System.currentTimeMillis() - providerResolveStart}ms")
                        result
                    }
                    Log.d(TAG, "observeConversations: total enrichment took ${System.currentTimeMillis() - startTime}ms, emitting ${enrichedItems.size} items")
                    _uiState.update {
                        it.copy(conversations = enrichedItems, isLoading = false, error = null, hasLoadedFromCache = true)
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
