package app.svarla.data.remote.api

import app.svarla.data.remote.dto.NumberListResponse
import app.svarla.data.remote.dto.SetDefaultNumberRequest
import app.svarla.data.remote.dto.SetDefaultNumberResponse
import app.svarla.data.remote.dto.UpdateBlockInboundRequest
import app.svarla.data.remote.dto.UpdateBlockInboundResponse
import app.svarla.data.remote.dto.UpdateLabelRequest
import app.svarla.data.remote.dto.UpdateLabelResponse
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class NumbersApiImpl @Inject constructor(
    private val apiClient: ApiClient
) : NumbersApi {

    override suspend fun getNumbers(): NumberListResponse {
        return apiClient.get("/api/numbers")
    }

    override suspend fun updateLabel(number: String, request: UpdateLabelRequest): UpdateLabelResponse {
        return apiClient.put("/api/numbers/$number/label", request)
    }

    override suspend fun syncNumbers(): NumberListResponse {
        return apiClient.post("/api/numbers/sync")
    }

    override suspend fun updateBlockInbound(number: String, request: UpdateBlockInboundRequest): UpdateBlockInboundResponse {
        return apiClient.put("/api/numbers/$number/block-inbound", request)
    }

    override suspend fun setDefaultNumber(request: SetDefaultNumberRequest): SetDefaultNumberResponse {
        return apiClient.put("/api/numbers/default", request)
    }
}
