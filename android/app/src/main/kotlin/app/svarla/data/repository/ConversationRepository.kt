package app.svarla.data.repository

import android.util.Log
import app.svarla.data.local.dao.ConversationDao
import app.svarla.data.local.dao.MessageDao
import app.svarla.data.local.dao.ProviderNumberDao
import app.svarla.data.local.entity.Conversation
import app.svarla.data.local.entity.Message
import app.svarla.data.local.entity.MessageDirection
import app.svarla.data.local.entity.MessageStatus
import app.svarla.data.remote.api.ReadStateApi
import app.svarla.data.remote.api.SmsApi
import app.svarla.data.remote.dto.ConversationDto
import app.svarla.data.remote.dto.MessageDto
import app.svarla.data.remote.dto.WebSocketEvent
import app.svarla.data.remote.sync.SyncManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Repository for managing conversation threads and messages.
 *
 * Conversations are keyed by the pair (providerNumber, phoneNumber) so that
 * different "from" numbers with the same remote party are separate threads.
 *
 * Phone number normalization: local numbers (e.g. 070...) are matched against
 * their E.164 equivalent (e.g. +4670...) using the provider number's country prefix.
 *
 * Requirements covered: 4.1, 4.2, 4.3, 4.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */
@Singleton
class ConversationRepository @Inject constructor(
    private val conversationDao: ConversationDao,
    private val messageDao: MessageDao,
    private val providerNumberDao: ProviderNumberDao,
    private val smsApi: SmsApi,
    private val readStateApi: ReadStateApi,
    private val syncManager: SyncManager,
    private val json: Json
) {
    companion object {
        private const val TAG = "ConversationRepository"
        private const val DEFAULT_MESSAGE_LIMIT = 100
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init {
        observeWebSocketEvents()
    }

    /**
     * Observe all conversation threads sorted by most recent message first.
     * Returns a Flow that updates whenever the local cache changes.
     */
    fun observeConversations(): Flow<List<Conversation>> {
        return conversationDao.getAll()
    }

    /**
     * Observe messages for a specific conversation, limited to the most recent [limit].
     * Returns a Flow that updates as new messages arrive.
     */
    fun observeMessages(phoneNumber: String, limit: Int = DEFAULT_MESSAGE_LIMIT): Flow<List<Message>> {
        return messageDao.getByConversation(phoneNumber, limit)
    }

    /**
     * Observe messages for a specific conversation thread identified by both the
     * provider number and the remote phone number.
     * This ensures messages from different provider numbers are shown in separate threads.
     */
    fun observeMessages(providerNumber: String, phoneNumber: String, limit: Int = DEFAULT_MESSAGE_LIMIT): Flow<List<Message>> {
        return if (providerNumber.isNotEmpty()) {
            messageDao.getByConversationAndProvider(phoneNumber, providerNumber, limit)
        } else {
            messageDao.getByConversation(phoneNumber, limit)
        }
    }

    /**
     * Sync conversation threads from the server and update local cache.
     * Each conversation from the server includes its providerNumber to identify
     * the from+to pair.
     */
    suspend fun syncConversations() {
        try {
            val response = smsApi.getConversations()
            response.conversations.forEach { dto ->
                val providerNumber = dto.providerNumber ?: ""
                val phoneNumber = normalizePhoneNumber(dto.phoneNumber, providerNumber)

                val existing = conversationDao.getByProviderAndPhone(providerNumber, phoneNumber)
                if (existing != null) {
                    conversationDao.update(
                        existing.copy(
                            lastMessagePreview = dto.lastMessagePreview?.take(50) ?: existing.lastMessagePreview,
                            lastMessageTimestamp = dto.lastMessageTimestamp?.let { parseTimestamp(it) } ?: existing.lastMessageTimestamp,
                            lastReceivedAt = dto.lastReceivedAt?.let { parseTimestamp(it) } ?: existing.lastReceivedAt,
                            lastReadAt = dto.lastReadAt?.let { parseTimestamp(it) } ?: existing.lastReadAt
                        )
                    )
                } else {
                    // Also check for an existing conversation with the normalized number variant
                    val normalizedVariant = toE164(phoneNumber, providerNumber)
                    val existingNormalized = if (normalizedVariant != phoneNumber) {
                        conversationDao.getByProviderAndPhone(providerNumber, normalizedVariant)
                    } else null

                    if (existingNormalized != null) {
                        // Update existing normalized conversation
                        conversationDao.update(
                            existingNormalized.copy(
                                lastMessagePreview = dto.lastMessagePreview?.take(50) ?: existingNormalized.lastMessagePreview,
                                lastMessageTimestamp = dto.lastMessageTimestamp?.let { parseTimestamp(it) } ?: existingNormalized.lastMessageTimestamp,
                                lastReceivedAt = dto.lastReceivedAt?.let { parseTimestamp(it) } ?: existingNormalized.lastReceivedAt,
                                lastReadAt = dto.lastReadAt?.let { parseTimestamp(it) } ?: existingNormalized.lastReadAt
                            )
                        )
                    } else {
                        conversationDao.insert(
                            Conversation(
                                providerNumber = providerNumber,
                                phoneNumber = phoneNumber,
                                lastMessagePreview = dto.lastMessagePreview?.take(50),
                                lastMessageTimestamp = dto.lastMessageTimestamp?.let { parseTimestamp(it) },
                                lastReceivedAt = dto.lastReceivedAt?.let { parseTimestamp(it) },
                                lastReadAt = dto.lastReadAt?.let { parseTimestamp(it) },
                                createdAt = System.currentTimeMillis()
                            )
                        )
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to sync conversations", e)
            throw e
        }
    }

    /**
     * Load messages for a specific conversation from the server
     * and cache them locally.
     */
    suspend fun syncMessages(phoneNumber: String) {
        try {
            val response = smsApi.getMessages(phoneNumber, DEFAULT_MESSAGE_LIMIT)
            response.messages.forEach { dto ->
                val message = dto.toEntity()
                messageDao.insert(message)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to sync messages for $phoneNumber", e)
            throw e
        }
    }

    /**
     * Load messages for a specific conversation thread (identified by both provider and phone number)
     * from the server and cache them locally.
     */
    suspend fun syncMessages(providerNumber: String, phoneNumber: String) {
        try {
            val response = smsApi.getMessages(phoneNumber, DEFAULT_MESSAGE_LIMIT, providerNumber.ifEmpty { null })
            response.messages.forEach { dto ->
                val message = dto.toEntity()
                messageDao.insert(message)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to sync messages for $providerNumber -> $phoneNumber", e)
            throw e
        }
    }

    /**
     * Get the provider number label for a given provider number.
     */
    suspend fun getProviderNumberLabel(providerNumber: String?): String {
        if (providerNumber == null) return ""
        val number = providerNumberDao.getByNumber(providerNumber)
        return number?.label ?: providerNumber
    }

    /**
     * Get the provider number color for a given provider number.
     */
    suspend fun getProviderNumberColor(providerNumber: String?): String {
        if (providerNumber == null) return "#6750A4"
        val number = providerNumberDao.getByNumber(providerNumber)
        return number?.color ?: "#6750A4"
    }

    /**
     * Get the provider number label for a conversation by looking at the most recent message.
     */
    suspend fun getProviderNumberLabelForConversation(phoneNumber: String): String {
        val providerNumber = messageDao.getLastProviderNumberForConversation(phoneNumber) ?: return ""
        return getProviderNumberLabel(providerNumber)
    }

    /**
     * Get the provider number last used in a conversation thread.
     */
    suspend fun getLastProviderNumberForThread(phoneNumber: String): String? {
        return messageDao.getLastProviderNumberForConversation(phoneNumber)
    }

    /**
     * Mark a conversation thread as read locally and on the server.
     */
    suspend fun markThreadAsRead(phoneNumber: String) {
        val now = System.currentTimeMillis()
        conversationDao.markAsReadByPhone(phoneNumber, now)
        try {
            readStateApi.markThreadAsRead(phoneNumber)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to sync read state to server for $phoneNumber", e)
        }
    }

    /**
     * Mark a specific conversation thread (provider + phone) as read locally and on the server.
     */
    suspend fun markThreadAsRead(providerNumber: String, phoneNumber: String) {
        val now = System.currentTimeMillis()
        if (providerNumber.isNotEmpty()) {
            conversationDao.markAsRead(providerNumber, phoneNumber, now)
        } else {
            conversationDao.markAsReadByPhone(phoneNumber, now)
        }
        try {
            readStateApi.markThreadAsRead(phoneNumber)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to sync read state to server for $providerNumber -> $phoneNumber", e)
        }
    }

    /**
     * Remove a conversation (hide it from the list).
     * Deletes locally and marks as removed on the server.
     */
    suspend fun removeConversation(providerNumber: String, phoneNumber: String) {
        // Remove from local DB
        conversationDao.deleteByProviderAndPhone(providerNumber, phoneNumber)
        // Mark as removed on the server
        try {
            smsApi.removeConversation(phoneNumber)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to remove conversation on server for $phoneNumber", e)
        }
    }

    /**
     * Remove a single message (hide it from the conversation).
     * Deletes locally and marks as removed on the server.
     */
    suspend fun removeMessage(messageId: String) {
        // Remove from local DB
        messageDao.deleteById(messageId)
        // Mark as removed on the server
        try {
            smsApi.removeMessage(messageId)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to remove message on server: $messageId", e)
        }
    }

    /**
     * Mark a message as removed on the server only, without deleting from local DB.
     * Used to allow undo functionality — the local deletion is deferred until the user
     * leaves the conversation screen.
     */
    suspend fun markMessageRemovedOnServer(messageId: String) {
        try {
            smsApi.removeMessage(messageId)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to mark message as removed on server: $messageId", e)
        }
    }

    /**
     * Delete a message from the local database only (no server call).
     * Used for deferred cleanup after the user has already confirmed removal.
     */
    suspend fun deleteMessageLocally(messageId: String) {
        messageDao.deleteById(messageId)
    }

    /**
     * Restore a previously removed message (undo removal).
     * Re-inserts locally if we have the data, and restores on server.
     */
    suspend fun restoreMessage(messageId: String) {
        try {
            smsApi.restoreMessage(messageId)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to restore message on server: $messageId", e)
        }
    }

    /**
     * Observe WebSocket events for new messages and update local cache in real-time.
     */
    private fun observeWebSocketEvents() {
        scope.launch {
            syncManager.events.collect { event ->
                when (event.type) {
                    "new_message" -> handleNewMessageEvent(event)
                    "message_status" -> handleMessageStatusEvent(event)
                    "read_state_updated" -> handleReadStateUpdatedEvent(event)
                    "connected" -> {
                        try { syncConversations() } catch (_: Exception) {}
                    }
                }
            }
        }
    }

    private suspend fun handleNewMessageEvent(event: WebSocketEvent) {
        try {
            val data = event.data?.jsonObject ?: return
            val conversationNumber = data["conversationNumber"]?.jsonPrimitive?.content ?: return

            syncMessages(conversationNumber)
            syncConversations()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to handle new_message event", e)
        }
    }

    private suspend fun handleMessageStatusEvent(event: WebSocketEvent) {
        try {
            val data = event.data?.jsonObject ?: return
            val messageId = data["messageId"]?.jsonPrimitive?.content ?: return
            val status = data["status"]?.jsonPrimitive?.content ?: return

            messageDao.updateStatus(messageId, parseStatus(status))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to handle message_status event", e)
        }
    }

    private suspend fun handleReadStateUpdatedEvent(event: WebSocketEvent) {
        Log.d(TAG, "Received read_state_updated from another device")
        try {
            syncConversations()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to sync after read_state_updated", e)
        }
    }

    // ========================================================================
    // Phone number normalization
    // ========================================================================

    /**
     * Normalizes a phone number by converting local format to E.164
     * using the country prefix from the provider number.
     *
     * Example: providerNumber="+46701234567", phoneNumber="0701234567"
     * → returns "+46701234567" (replaces leading 0 with country prefix +46)
     *
     * If the number is already in E.164 format (starts with +), returns as-is.
     */
    fun normalizePhoneNumber(phoneNumber: String, providerNumber: String): String {
        if (phoneNumber.startsWith("+")) return phoneNumber
        if (providerNumber.isEmpty() || !providerNumber.startsWith("+")) return phoneNumber

        // Extract country prefix from the provider number
        val countryPrefix = extractCountryPrefix(providerNumber) ?: return phoneNumber

        // Replace leading 0 with country prefix
        if (phoneNumber.startsWith("0") && phoneNumber.length > 1) {
            return "+$countryPrefix${phoneNumber.substring(1)}"
        }

        return phoneNumber
    }

    /**
     * Attempts to convert a phone number to E.164 using the provider number's country prefix.
     * Returns the original number if already in E.164 format or conversion isn't possible.
     */
    private fun toE164(phoneNumber: String, providerNumber: String): String {
        return normalizePhoneNumber(phoneNumber, providerNumber)
    }

    /**
     * Extracts the country calling code from an E.164 phone number.
     * Handles 1-3 digit country codes.
     *
     * Examples:
     * - "+46701234567" → "46"
     * - "+1555123456" → "1"
     * - "+447123456789" → "44"
     */
    private fun extractCountryPrefix(e164Number: String): String? {
        if (!e164Number.startsWith("+") || e164Number.length < 4) return null

        val digits = e164Number.substring(1) // Remove leading +

        // Country codes are 1, 2, or 3 digits. Use known rules:
        // 1-digit: 1 (North America), 7 (Russia/Kazakhstan)
        // 2-digit: 20-69 (most of the world)
        // 3-digit: 200-999 (smaller countries)
        val firstDigit = digits[0]
        return when {
            firstDigit == '1' || firstDigit == '7' -> digits.substring(0, 1)
            digits.length >= 2 && digits.substring(0, 2).toIntOrNull()?.let { it in 20..69 } == true -> digits.substring(0, 2)
            digits.length >= 3 -> digits.substring(0, 3)
            else -> null
        }
    }

    // ========================================================================
    // Parsing utilities
    // ========================================================================

    internal fun parseDirection(direction: String?): MessageDirection {
        return when (direction?.uppercase()) {
            "SENT" -> MessageDirection.SENT
            "RECEIVED" -> MessageDirection.RECEIVED
            else -> MessageDirection.RECEIVED
        }
    }

    internal fun parseStatus(status: String?): MessageStatus {
        return when (status?.uppercase()) {
            "PENDING" -> MessageStatus.PENDING
            "SENT" -> MessageStatus.SENT
            "DELIVERED" -> MessageStatus.DELIVERED
            "FAILED" -> MessageStatus.FAILED
            "QUEUED" -> MessageStatus.QUEUED
            else -> MessageStatus.SENT
        }
    }

    internal fun parseTimestamp(timestamp: String?): Long {
        if (timestamp == null) return System.currentTimeMillis()
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

    private fun MessageDto.toEntity(): Message {
        return Message(
            id = id,
            providerMessageId = id,
            conversationNumber = conversationNumber,
            providerNumber = providerNumber,
            body = body,
            direction = parseDirection(direction),
            status = parseStatus(status),
            timestamp = parseTimestamp(timestamp)
        )
    }
}
