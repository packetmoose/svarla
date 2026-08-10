package app.svarla.data.remote.api

import app.svarla.data.remote.dto.NumberListResponse
import app.svarla.data.remote.dto.SetDefaultNumberRequest
import app.svarla.data.remote.dto.SetDefaultNumberResponse
import app.svarla.data.remote.dto.UpdateBlockInboundRequest
import app.svarla.data.remote.dto.UpdateBlockInboundResponse
import app.svarla.data.remote.dto.UpdateLabelRequest
import app.svarla.data.remote.dto.UpdateLabelResponse

/**
 * API service for provider number management endpoints.
 */
interface NumbersApi {

    /**
     * GET /api/numbers — List all provider numbers with labels.
     */
    suspend fun getNumbers(): NumberListResponse

    /**
     * PUT /api/numbers/{number}/label — Update the label for a provider number.
     */
    suspend fun updateLabel(number: String, request: UpdateLabelRequest): UpdateLabelResponse

    /**
     * POST /api/numbers/sync — Trigger sync of numbers from provider API.
     */
    suspend fun syncNumbers(): NumberListResponse

    /**
     * PUT /api/numbers/{number}/block-inbound — Enable or disable blocking of incoming calls.
     */
    suspend fun updateBlockInbound(number: String, request: UpdateBlockInboundRequest): UpdateBlockInboundResponse

    /**
     * PUT /api/numbers/default — Set the default number for outbound calls and SMS.
     */
    suspend fun setDefaultNumber(request: SetDefaultNumberRequest): SetDefaultNumberResponse
}
