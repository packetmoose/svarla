package app.svarla.data.remote.api

import app.svarla.domain.notifications.NotificationApiResponse
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class NotificationsApiImpl @Inject constructor(
    private val apiClient: ApiClient
) : NotificationsApi {

    override suspend fun getPendingNotifications(): List<NotificationApiResponse> {
        return apiClient.get("/api/notifications")
    }
}
