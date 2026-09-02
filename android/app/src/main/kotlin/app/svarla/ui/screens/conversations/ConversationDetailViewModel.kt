package app.svarla.ui.screens.conversations

import android.util.Log
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.svarla.data.local.dao.CallHistoryDao
import app.svarla.data.local.entity.CallType
import app.svarla.data.local.entity.Message
import app.svarla.data.local.entity.MessageDirection
import app.svarla.data.repository.ConversationRepository
import app.svarla.domain.call.VoiceCallManager
import app.svarla.domain.contacts.ContactResolver
import app.svarla.domain.sms.SmsManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

/**
 * SMS segment size constants.
 * Standard GSM: 160 chars for single, 153 per segment for multipart.
 */
private const val SINGLE_SMS_LIMIT = 160
private const val MULTIPART_SEGMENT_SIZE = 153

data class ConversationDetailUiState(
    val phoneNumber: String = "",
    val displayName: String = "",
    val providerNumberLabel: String = "",
    val providerNumberColor: String = "#6750A4",
    val timelineItems: List<TimelineItem> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val inputText: String = "",
    val isSending: Boolean = false,
    val sendError: String? = null,
    val providerNumber: String = "",
    val removedMessageIds: Set<String> = emptySet()
) {
    val charCount: Int get() = inputText.length
    val segmentCount: Int get() = calculateSegments(inputText)
    val showSegmentIndicator: Boolean get() = inputText.length > SINGLE_SMS_LIMIT

    /**
     * Whether the conversation number is numeric and can be replied to.
     * Non-numeric numbers represent custom sender names (e.g. "MyBrand") and cannot receive SMS.
     */
    val isRepliable: Boolean get() = phoneNumber.matches(Regex("^\\+?\\d+$"))
}

private fun calculateSegments(text: String): Int {
    if (text.isEmpty()) return 0
    val length = text.length
    return if (length <= SINGLE_SMS_LIMIT) 1
    else (length + MULTIPART_SEGMENT_SIZE - 1) / MULTIPART_SEGMENT_SIZE
}

data class MessageUiItem(
    val id: String,
    val body: String,
    val timestamp: Long,
    val direction: MessageDirection,
    val status: String,
    val isSent: Boolean
)

sealed interface TimelineItem {
    val timestamp: Long
    val id: String

    data class MessageItem(val message: MessageUiItem) : TimelineItem {
        override val timestamp: Long get() = message.timestamp
        override val id: String get() = message.id
    }

    data class CallItem(
        override val id: String,
        override val timestamp: Long,
        val callType: CallType,
        val durationSeconds: Int?
    ) : TimelineItem
}

@HiltViewModel
class ConversationDetailViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val conversationRepository: ConversationRepository,
    private val smsManager: SmsManager,
    private val callHistoryDao: CallHistoryDao,
    private val contactResolver: ContactResolver,
    private val voiceCallManager: VoiceCallManager,
    private val syncManager: app.svarla.data.remote.sync.SyncManager,
    private val notificationHandler: app.svarla.domain.notifications.NotificationHandler
) : ViewModel() {

    private val phoneNumber: String = savedStateHandle.get<String>("phoneNumber") ?: ""
    private val providerNumber: String = savedStateHandle.get<String>("providerNumber") ?: ""

    private val _uiState = MutableStateFlow(
        ConversationDetailUiState(
            phoneNumber = phoneNumber,
            providerNumber = providerNumber,
            displayName = contactResolver.resolveContactName(phoneNumber) ?: phoneNumber
        )
    )
    val uiState: StateFlow<ConversationDetailUiState> = _uiState.asStateFlow()

    init {
        if (phoneNumber.isNotEmpty()) {
            observeMessages()
            syncFromServer()
            markAsRead()
            observeReconnections()
        }
    }

    fun onInputChanged(text: String) {
        _uiState.update { it.copy(inputText = text, sendError = null) }
    }

    fun sendMessage() {
        val state = _uiState.value
        val body = state.inputText.trim()
        if (body.isEmpty() || state.isSending) return

        if (providerNumber.isEmpty()) {
            _uiState.update { it.copy(sendError = "No sender number available") }
            return
        }

        _uiState.update { it.copy(isSending = true, sendError = null) }

        viewModelScope.launch {
            val result = smsManager.sendMessage(
                from = providerNumber,
                to = phoneNumber,
                body = body
            )
            when (result) {
                is app.svarla.domain.sms.SendMessageResult.Success,
                is app.svarla.domain.sms.SendMessageResult.Queued -> {
                    _uiState.update { it.copy(inputText = "", isSending = false) }
                }
                is app.svarla.domain.sms.SendMessageResult.Failed -> {
                    _uiState.update { it.copy(isSending = false, sendError = result.error) }
                }
            }
        }
    }

    fun makeCall() {
        if (providerNumber.isEmpty()) return
        voiceCallManager.makeCall(from = providerNumber, to = phoneNumber)
    }

    /**
     * Remove a message (gray it out and mark removed on server).
     * User can undo before leaving the screen.
     * The message is NOT deleted from the local DB immediately so that the
     * Room Flow keeps emitting it and the "Message removed" + Undo placeholder
     * remains visible in the list.
     */
    fun removeMessage(messageId: String) {
        // Add to removed set immediately (shows grayed out + undo)
        _uiState.update { it.copy(removedMessageIds = it.removedMessageIds + messageId) }
        // Mark as removed on the server only; local DB deletion is deferred to onCleared()
        viewModelScope.launch {
            try {
                conversationRepository.markMessageRemovedOnServer(messageId)
            } catch (_: Exception) {}
        }
    }

    /**
     * Undo removal of a message (restore it both in UI and on server).
     */
    fun undoRemoveMessage(messageId: String) {
        _uiState.update { it.copy(removedMessageIds = it.removedMessageIds - messageId) }
        // Restore on server
        viewModelScope.launch {
            try {
                conversationRepository.restoreMessage(messageId)
            } catch (_: Exception) {}
        }
    }

    /**
     * Remove the entire conversation. Deletes locally and marks removed on server.
     */
    fun removeConversation() {
        viewModelScope.launch {
            try {
                conversationRepository.removeConversation(providerNumber, phoneNumber)
            } catch (_: Exception) {}
        }
    }

    override fun onCleared() {
        super.onCleared()
        // Use a non-cancellable context since viewModelScope is being cancelled
        kotlinx.coroutines.GlobalScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            // Mark as read when leaving the conversation
            try {
                conversationRepository.markThreadAsRead(providerNumber, phoneNumber)
            } catch (_: Exception) {}
            // Now delete locally any messages that were removed and not undone.
            // The server was already notified in removeMessage(), so only local cleanup needed.
            val removedIds = _uiState.value.removedMessageIds
            removedIds.forEach { messageId ->
                try {
                    conversationRepository.deleteMessageLocally(messageId)
                } catch (_: Exception) {}
            }
        }
    }

    fun retry() {
        syncFromServer()
    }

    // ========================================================================
    // Private
    // ========================================================================

    private fun observeMessages() {
        viewModelScope.launch {
            val callHistoryFlow = if (providerNumber.isNotEmpty()) {
                callHistoryDao.getByPhoneAndProvider(phoneNumber, providerNumber)
            } else {
                callHistoryDao.getByPhoneNumber(phoneNumber)
            }
            combine(
                conversationRepository.observeMessages(providerNumber, phoneNumber, 100),
                callHistoryFlow
            ) { messages, callHistory ->
                Pair(messages, callHistory)
            }
                .catch { e ->
                    _uiState.update { it.copy(error = e.message, isLoading = false) }
                }
                .collect { (messages, callHistory) ->
                    val messageItems = messages
                        .map { TimelineItem.MessageItem(it.toUiItem()) }

                    val callItems = callHistory
                        .map { entry ->
                            TimelineItem.CallItem(
                                id = "call_${entry.id}",
                                timestamp = entry.timestamp,
                                callType = entry.callType,
                                durationSeconds = entry.durationSeconds
                            )
                        }

                    val timeline = (messageItems + callItems)
                        .sortedBy { it.timestamp }

                    val providerNumber = messages.firstOrNull { it.providerNumber != null }?.providerNumber
                    val label = if (providerNumber != null) {
                        conversationRepository.getProviderNumberLabel(providerNumber)
                    } else ""
                    val color = if (providerNumber != null) {
                        conversationRepository.getProviderNumberColor(providerNumber)
                    } else "#6750A4"

                    _uiState.update {
                        it.copy(
                            timelineItems = timeline,
                            providerNumberLabel = label,
                            providerNumberColor = color,
                            isLoading = false,
                            error = null
                        )
                    }
                }
        }
    }

    private fun syncFromServer() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            try {
                conversationRepository.syncMessages(providerNumber, phoneNumber)
            } catch (e: Exception) {
                _uiState.update { it.copy(error = e.message, isLoading = false) }
            }
        }
        // Delayed retry to catch messages that weren't committed on the server yet
        // when navigating from a notification tap (covers the no-WebSocket case)
        viewModelScope.launch {
            kotlinx.coroutines.delay(1500)
            try {
                conversationRepository.syncMessages(providerNumber, phoneNumber)
            } catch (_: Exception) {}
        }
    }

    private fun markAsRead() {
        viewModelScope.launch {
            conversationRepository.markThreadAsRead(providerNumber, phoneNumber)
        }
        // Dismiss any pending SMS notifications for this conversation
        notificationHandler.dismissConversationNotifications(phoneNumber)
    }

    /**
     * Re-sync messages when WebSocket reconnects or when a new_message event
     * arrives for this conversation. This covers the race condition where a push
     * notification arrives but the message isn't yet in the API response when
     * the initial syncFromServer() runs (e.g. navigating from a notification tap).
     */
    private fun observeReconnections() {
        viewModelScope.launch {
            syncManager.events.collect { event ->
                when (event.type) {
                    "connected" -> {
                        try {
                            conversationRepository.syncMessages(providerNumber, phoneNumber)
                        } catch (_: Exception) {}
                    }
                    "new_message" -> {
                        try {
                            val data = event.data?.jsonObject
                            val conversationNumber = data?.get("conversationNumber")
                                ?.jsonPrimitive?.content
                            if (conversationNumber == phoneNumber) {
                                conversationRepository.syncMessages(providerNumber, phoneNumber)
                            }
                        } catch (_: Exception) {}
                    }
                }
            }
        }
    }

    private fun Message.toUiItem(): MessageUiItem {
        return MessageUiItem(
            id = id,
            body = body,
            timestamp = timestamp,
            direction = direction,
            status = status.name.lowercase(),
            isSent = direction == MessageDirection.SENT
        )
    }
}
