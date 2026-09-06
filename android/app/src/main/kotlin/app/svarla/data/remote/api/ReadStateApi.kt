package app.svarla.data.remote.api

import app.svarla.data.remote.dto.ReadStateCountsDto

/**
 * API service for read-state endpoints.
 * Manages Global_Read_State for badge indicators.
 *
 * Requirements covered: 15.1-15.12
 */
interface ReadStateApi {

    /**
     * GET /api/read-state/counts
     * Returns the current unread/unseen counts for badge display.
     */
    suspend fun getCounts(): ReadStateCountsDto

    /**
     * POST /api/read-state/calls
     * Mark all missed calls as viewed. Returns updated counts.
     */
    suspend fun markMissedCallsAsViewed(): ReadStateCountsDto

    /**
     * POST /api/read-state/messages/{number}?from={providerNumber}
     * Mark all messages in a thread as read. A thread is identified by the
     * (providerNumber, phoneNumber) pair, so the provider number is required.
     * Returns updated counts.
     */
    suspend fun markThreadAsRead(providerNumber: String, phoneNumber: String): ReadStateCountsDto
}
