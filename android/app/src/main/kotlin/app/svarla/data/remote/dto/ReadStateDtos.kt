package app.svarla.data.remote.dto

import kotlinx.serialization.Serializable

/**
 * Response from read-state API endpoints containing badge counts.
 */
@Serializable
data class ReadStateCountsDto(
    val unreadMessages: Int = 0,
    val unseenMissedCalls: Int = 0
)
