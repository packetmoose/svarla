package app.svarla.data.remote.api

import app.svarla.data.remote.dto.ConversationListResponse
import app.svarla.data.remote.dto.MessageListResponse
import app.svarla.data.remote.dto.SendSmsRequest
import app.svarla.data.remote.dto.SendSmsResponse

/**
 * API service for SMS and conversation endpoints.
 */
interface SmsApi {

    /**
     * POST /api/sms/send — Send outbound SMS.
     */
    suspend fun sendSms(request: SendSmsRequest): SendSmsResponse

    /**
     * GET /api/conversations — List conversation threads (paginated).
     */
    suspend fun getConversations(page: Int = 1, pageSize: Int = 50): ConversationListResponse

    /**
     * GET /api/conversations/{number} — Get messages in a thread (last 100).
     */
    suspend fun getMessages(phoneNumber: String, limit: Int = 100): MessageListResponse

    /**
     * DELETE /api/conversations/{number} — Mark a conversation as removed.
     */
    suspend fun removeConversation(phoneNumber: String)

    /**
     * DELETE /api/messages/{id} — Mark a message as removed.
     */
    suspend fun removeMessage(messageId: String)

    /**
     * POST /api/messages/{id}/restore — Restore a previously removed message.
     */
    suspend fun restoreMessage(messageId: String)
}
