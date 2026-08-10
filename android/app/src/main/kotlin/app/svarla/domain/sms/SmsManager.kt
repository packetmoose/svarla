package app.svarla.domain.sms

import android.util.Log
import app.svarla.data.local.dao.ConversationDao
import app.svarla.data.local.dao.MessageDao
import app.svarla.data.local.entity.Conversation
import app.svarla.data.local.entity.Message
import app.svarla.data.local.entity.MessageDirection
import app.svarla.data.local.entity.MessageStatus
import app.svarla.data.remote.api.SmsApi
import app.svarla.data.remote.dto.SendSmsRequest
import app.svarla.data.remote.dto.WebSocketEvent
import app.svarla.data.remote.sync.SyncManager
import app.svarla.domain.call.NetworkMonitor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Result of a send message attempt.
 */
sealed class SendMessageResult {
    data class Success(val messageId: String) : SendMessageResult()
    data class Queued(val messageId: String) : SendMessageResult()
    data class Failed(val error: String) : SendMessageResult()
}

/**
 * Manages SMS sending, status tracking, retry logic, and offline queueing.
 *
 * Responsibilities:
 * - Send SMS via backend API with the selected provider number
 * - Handle message status transitions: PENDING → SENT or FAILED
 * - Retry failed messages up to 3 times
 * - Queue messages when offline (QUEUED status), send when connectivity returns
 * - Observe message_status WebSocket events to update local message statuses
 *
 * Requirements covered: 3.1, 3.2, 3.3, 3.6
 */
@Singleton
class SmsManager @Inject constructor(
    private val smsApi: SmsApi,
    private val messageDao: MessageDao,
    private val conversationDao: ConversationDao,
    private val syncManager: SyncManager,
    private val networkMonitor: NetworkMonitor
) {
    companion object {
        private const val TAG = "SmsManager"
        private const val MAX_RETRY_COUNT = 3
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _isSending = MutableStateFlow(false)
    /** Observable sending state for UI. */
    val isSending: StateFlow<Boolean> = _isSending.asStateFlow()

    init {
        observeWebSocketEvents()
        observeConnectivity()
    }

    /**
     * Send an SMS message.
     *
     * Sends via the backend API. If offline, queues locally for later delivery.
     *
     * @param from The provider number to send from (E.164)
     * @param to The destination phone number (E.164)
     * @param body The message body (1-1600 characters)
     * @return [SendMessageResult] indicating success, queued, or failure
     */
    suspend fun sendMessage(from: String, to: String, body: String): SendMessageResult {
        val isOnline = networkMonitor.isConnected()
        // Normalize destination: if local number (no +), derive country code from the from number
        val normalizedTo = normalizeToE164(to, from)

        if (!isOnline) {
            val messageId = UUID.randomUUID().toString()
            val timestamp = System.currentTimeMillis()

            ensureConversationExists(from, normalizedTo, body, timestamp)

            val message = Message(
                id = messageId,
                conversationNumber = normalizedTo,
                providerNumber = from,
                body = body,
                direction = MessageDirection.SENT,
                status = MessageStatus.QUEUED,
                timestamp = timestamp,
                retryCount = 0
            )
            messageDao.insert(message)

            Log.d(TAG, "Network unavailable, message queued: $messageId")
            return SendMessageResult.Queued(messageId)
        }

        // Send directly via API
        _isSending.value = true

        val messageId = UUID.randomUUID().toString()
        val timestamp = System.currentTimeMillis()

        // Insert optimistically so it appears in the conversation immediately
        ensureConversationExists(from, normalizedTo, body, timestamp)
        val pendingMessage = Message(
            id = messageId,
            conversationNumber = normalizedTo,
            providerNumber = from,
            body = body,
            direction = MessageDirection.SENT,
            status = MessageStatus.PENDING,
            timestamp = timestamp,
            retryCount = 0
        )
        messageDao.insert(pendingMessage)

        return try {
            val request = SendSmsRequest(
                to = to,
                body = body,
                from = from
            )

            val response = smsApi.sendSms(request)

            // Update with server ID and SENT status
            val sentMessage = pendingMessage.copy(
                providerMessageId = response.id,
                status = MessageStatus.SENT
            )
            messageDao.insert(sentMessage)

            Log.d(TAG, "Message sent successfully: ${response.id}")
            SendMessageResult.Success(messageId)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send message", e)
            messageDao.updateStatus(messageId, MessageStatus.FAILED)
            SendMessageResult.Failed(e.message ?: "Failed to send message")
        } finally {
            _isSending.value = false
        }
    }

    /**
     * Normalize a local phone number to E.164 using the country code from the from number.
     * If already E.164 (starts with +), returns as-is.
     * If local (starts with 0), strips leading 0 and prepends country code from `from`.
     */
    private fun normalizeToE164(to: String, from: String): String {
        val trimmed = to.trim()
        if (trimmed.startsWith("+")) return trimmed
        if (!from.startsWith("+") || from.length < 3) return trimmed

        // Extract country code from from number (1-3 digits after +)
        val fromDigits = from.drop(1)
        val countryCode = when {
            fromDigits[0] == '1' || fromDigits[0] == '7' -> fromDigits.take(1)
            else -> {
                val twoDigit = fromDigits.take(2)
                val twoDigitCodes = setOf(
                    "20","27","30","31","32","33","34","36","39",
                    "40","41","43","44","45","46","47","48","49",
                    "51","52","53","54","55","56","57","58",
                    "60","61","62","63","64","65","66",
                    "81","82","84","86","90","91","92","93","94","95","98"
                )
                if (twoDigitCodes.contains(twoDigit)) twoDigit else fromDigits.take(3)
            }
        }

        return if (trimmed.startsWith("0")) {
            "+$countryCode${trimmed.drop(1)}"
        } else {
            // Numbers not starting with 0 are short codes — return as-is without country code prefix
            trimmed
        }
    }

    private suspend fun ensureConversationExists(from: String, to: String, body: String, timestamp: Long) {
        val existingConversation = conversationDao.getByProviderAndPhone(from, to)
        if (existingConversation == null) {
            conversationDao.insert(
                Conversation(
                    providerNumber = from,
                    phoneNumber = to,
                    lastMessagePreview = body.take(100),
                    lastMessageTimestamp = timestamp,
                    createdAt = timestamp
                )
            )
        } else {
            conversationDao.update(
                existingConversation.copy(
                    lastMessagePreview = body.take(100),
                    lastMessageTimestamp = timestamp
                )
            )
        }
    }

    /**
     * Retry sending a failed/queued message.
     *
     * @param messageId The ID of the message to retry
     * @return [SendMessageResult] indicating success or failure, or null if message not found or retry limit reached
     */
    suspend fun retryMessage(messageId: String): SendMessageResult? {
        val message = messageDao.getById(messageId) ?: run {
            Log.w(TAG, "Cannot retry: message $messageId not found")
            return null
        }

        if (message.status != MessageStatus.FAILED && message.status != MessageStatus.QUEUED) {
            Log.w(TAG, "Cannot retry: message $messageId is in ${message.status} state")
            return null
        }

        if (message.retryCount >= MAX_RETRY_COUNT) {
            Log.w(TAG, "Cannot retry: message $messageId has reached max retry count (${message.retryCount})")
            return SendMessageResult.Failed("Maximum retry attempts reached")
        }

        if (!networkMonitor.isConnected()) {
            messageDao.updateStatus(messageId, MessageStatus.QUEUED)
            return SendMessageResult.Queued(messageId)
        }

        // Update to PENDING and increment retry count
        val updatedMessage = message.copy(
            status = MessageStatus.PENDING,
            retryCount = message.retryCount + 1
        )
        messageDao.insert(updatedMessage)

        _isSending.value = true
        return try {
            val request = SendSmsRequest(
                to = message.conversationNumber,
                body = message.body,
                from = message.providerNumber ?: ""
            )

            val response = smsApi.sendSms(request)

            val sentMessage = updatedMessage.copy(
                providerMessageId = response.id,
                status = MessageStatus.SENT
            )
            messageDao.insert(sentMessage)

            Log.d(TAG, "Message retry successful: $messageId")
            SendMessageResult.Success(messageId)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to retry message: $messageId", e)
            messageDao.updateStatus(messageId, MessageStatus.FAILED)
            SendMessageResult.Failed(e.message ?: "Failed to send message")
        } finally {
            _isSending.value = false
        }
    }

    // ========================================================================
    // Private implementation
    // ========================================================================

    /**
     * Observe message_status WebSocket events to update local message statuses.
     */
    private fun observeWebSocketEvents() {
        scope.launch {
            syncManager.events.collect { event ->
                handleWebSocketEvent(event)
            }
        }
    }

    private suspend fun handleWebSocketEvent(event: WebSocketEvent) {
        if (event.type != "message_status") return

        val data = event.data?.jsonObject ?: return
        val messageId = data["messageId"]?.jsonPrimitive?.content ?: return
        val statusStr = data["status"]?.jsonPrimitive?.content ?: return

        val newStatus = when (statusStr.uppercase()) {
            "SENT" -> MessageStatus.SENT
            "DELIVERED" -> MessageStatus.DELIVERED
            "FAILED" -> MessageStatus.FAILED
            else -> return
        }

        // Find message by providerMessageId
        val localMessage = messageDao.getByProviderMessageId(messageId)
        if (localMessage != null) {
            messageDao.updateStatus(localMessage.id, newStatus)
            Log.d(TAG, "Updated message status: ${localMessage.id} → $newStatus (via WebSocket)")
        } else {
            Log.d(TAG, "Received status update for unknown providerMessageId: $messageId")
        }
    }

    /**
     * Observe connectivity changes and send queued messages when network returns.
     */
    private fun observeConnectivity() {
        scope.launch {
            networkMonitor.isNetworkAvailable.collect { isConnected ->
                if (isConnected) {
                    sendQueuedMessages()
                }
            }
        }
    }

    /**
     * Send all messages currently in QUEUED status.
     */
    private suspend fun sendQueuedMessages() {
        val queuedMessages = messageDao.getByStatus(MessageStatus.QUEUED)
        if (queuedMessages.isEmpty()) return

        Log.d(TAG, "Sending ${queuedMessages.size} queued messages")
        for (message in queuedMessages) {
            try {
                val request = SendSmsRequest(
                    to = message.conversationNumber,
                    body = message.body,
                    from = message.providerNumber ?: ""
                )
                val response = smsApi.sendSms(request)
                val sentMessage = message.copy(
                    providerMessageId = response.id,
                    status = MessageStatus.SENT
                )
                messageDao.insert(sentMessage)
                Log.d(TAG, "Queued message sent: ${message.id}")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send queued message: ${message.id}", e)
                messageDao.updateStatus(message.id, MessageStatus.FAILED)
            }
        }
    }
}
