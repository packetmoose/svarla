package app.svarla.data.remote.api

import app.svarla.data.remote.dto.SyncStateResponse

/**
 * API service for sync endpoints.
 */
interface SyncApi {

    /**
     * GET /api/sync/state — Full state sync (fallback for initial load and polling).
     */
    suspend fun getSyncState(): SyncStateResponse
}
