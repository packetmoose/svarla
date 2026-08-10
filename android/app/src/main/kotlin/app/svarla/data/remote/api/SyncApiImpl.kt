package app.svarla.data.remote.api

import app.svarla.data.remote.dto.SyncStateResponse
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SyncApiImpl @Inject constructor(
    private val apiClient: ApiClient
) : SyncApi {

    override suspend fun getSyncState(): SyncStateResponse {
        return apiClient.get("/api/sync/state")
    }
}
