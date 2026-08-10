package app.svarla.data.remote.api

import app.svarla.domain.notifications.NotificationApiResponse

/**
 * API service for notification endpoints.
 */
interface NotificationsApi {

    /**
     * GET /api/notifications — Fetch all pending notifications.
     * Used on WebSocket reconnect to sync notifications that were missed while offline.
     *
     * Requirements: 5.3, 5.5, 8.1
     */
    suspend fun getPendingNotifications(): List<NotificationApiResponse>
}
