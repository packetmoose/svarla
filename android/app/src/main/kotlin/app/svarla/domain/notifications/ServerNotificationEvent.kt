package app.svarla.domain.notifications

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Represents the data payload of a `notification_created` WebSocket event from the server.
 *
 * Example server payload:
 * ```json
 * {
 *   "id": "uuid",
 *   "notificationType": "incoming_call",
 *   "status": "pending",
 *   "sourceEntityId": "call-uuid",
 *   "sourceEntityType": "call_history",
 *   "payload": { "callerNumber": "+1234...", ... },
 *   "createdAt": "2024-01-01T00:00:00Z"
 * }
 * ```
 */
@Serializable
data class NotificationCreatedEvent(
    val id: String,
    val notificationType: String,
    val status: String,
    val sourceEntityId: String,
    val sourceEntityType: String,
    val payload: JsonElement? = null,
    val createdAt: String? = null
)

/**
 * Represents the data payload of a `notification_updated` WebSocket event from the server.
 *
 * Example server payload:
 * ```json
 * {
 *   "id": "uuid",
 *   "notificationType": "missed_call",
 *   "status": "pending",
 *   "updatedAt": "2024-01-01T00:01:00Z"
 * }
 * ```
 */
@Serializable
data class NotificationUpdatedEvent(
    val id: String,
    val notificationType: String? = null,
    val status: String? = null,
    val updatedAt: String? = null
)

/**
 * Represents a notification entity as returned by the REST API `GET /api/notifications`.
 * The REST endpoint returns notification entities with a `type` field (not `notificationType`
 * as used in WebSocket events), so this separate DTO handles deserialization correctly.
 *
 * Example REST response:
 * ```json
 * {
 *   "id": "uuid",
 *   "type": "missed_call",
 *   "status": "pending",
 *   "sourceEntityId": "call-uuid",
 *   "sourceEntityType": "call_history",
 *   "payload": { "callerNumber": "+1234...", ... },
 *   "createdAt": "2024-01-01T00:00:00Z",
 *   "updatedAt": "2024-01-01T00:00:00Z"
 * }
 * ```
 */
@Serializable
data class NotificationApiResponse(
    val id: String,
    val type: String,
    val status: String,
    val sourceEntityId: String,
    val sourceEntityType: String,
    val payload: JsonElement? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
) {
    /**
     * Converts this REST API response to a [NotificationCreatedEvent] that can
     * be passed to [NotificationHandler.handleNotificationCreated].
     */
    fun toNotificationCreatedEvent(): NotificationCreatedEvent {
        return NotificationCreatedEvent(
            id = id,
            notificationType = type,
            status = status,
            sourceEntityId = sourceEntityId,
            sourceEntityType = sourceEntityType,
            payload = payload,
            createdAt = createdAt
        )
    }
}
