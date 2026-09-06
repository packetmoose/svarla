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
     * When providerNumber is specified, only messages for that specific thread are returned.
     */
    suspend fun getMessages(phoneNumber: String, limit: Int = 100, providerNumber: String? = null): MessageListResponse

    /**
     * DELETE /api/conversations/{number}?from={providerNumber} — Mark a
     * conversation as removed. A thread is identified by the (providerNumber,
     * phoneNumber) pair, so the provider number is required.
     */
    suspend fun removeConversation(providerNumber: String, phoneNumber: String)

    /**
     * DELETE /api/messages/{id} — Mark a message as removed.
     */
    suspend fun removeMessage(messageId: String)

    /**
     * POST /api/messages/{id}/restore — Restore a previously removed message.
     */
    suspend fun restoreMessage(messageId: String)
}
