package app.svarla.data.remote.api

import app.svarla.data.remote.dto.ReadStateCountsDto
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ReadStateApiImpl @Inject constructor(
    private val apiClient: ApiClient
) : ReadStateApi {

    override suspend fun getCounts(): ReadStateCountsDto {
        return apiClient.get("/api/read-state/counts")
    }

    override suspend fun markMissedCallsAsViewed(): ReadStateCountsDto {
        return apiClient.post("/api/read-state/calls")
    }

    override suspend fun markThreadAsRead(phoneNumber: String): ReadStateCountsDto {
        val encodedNumber = phoneNumber.replace("+", "%2B")
        return apiClient.post("/api/read-state/messages/$encodedNumber")
    }
}
