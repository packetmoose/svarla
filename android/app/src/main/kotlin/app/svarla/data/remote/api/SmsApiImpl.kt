package app.svarla.data.remote.api

import app.svarla.data.remote.dto.ConversationListResponse
import app.svarla.data.remote.dto.MessageListResponse
import app.svarla.data.remote.dto.SendSmsRequest
import app.svarla.data.remote.dto.SendSmsResponse
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SmsApiImpl @Inject constructor(
    private val apiClient: ApiClient
) : SmsApi {

    override suspend fun sendSms(request: SendSmsRequest): SendSmsResponse {
        return apiClient.post("/api/sms/send", request)
    }

    override suspend fun getConversations(page: Int, pageSize: Int): ConversationListResponse {
        return apiClient.get(
            "/api/conversations",
            mapOf("page" to page, "page_size" to pageSize)
        )
    }

    override suspend fun getMessages(phoneNumber: String, limit: Int): MessageListResponse {
        return apiClient.get(
            "/api/conversations/$phoneNumber",
            mapOf("limit" to limit)
        )
    }

    override suspend fun removeConversation(phoneNumber: String) {
        apiClient.delete("/api/conversations/$phoneNumber")
    }

    override suspend fun removeMessage(messageId: String) {
        apiClient.delete("/api/messages/$messageId")
    }

    override suspend fun restoreMessage(messageId: String) {
        apiClient.post<Unit>("/api/messages/$messageId/restore")
    }
}
