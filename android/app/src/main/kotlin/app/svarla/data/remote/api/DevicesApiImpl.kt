package app.svarla.data.remote.api

import app.svarla.data.remote.dto.DeviceListResponse
import app.svarla.data.remote.dto.DeviceRegistrationRequest
import app.svarla.data.remote.dto.DeviceRegistrationResponse
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class DevicesApiImpl @Inject constructor(
    private val apiClient: ApiClient
) : DevicesApi {

    override suspend fun getDevices(): DeviceListResponse {
        return apiClient.get("/api/devices")
    }

    override suspend fun registerDevice(deviceId: String, deviceName: String): DeviceRegistrationResponse {
        return apiClient.post(
            path = "/api/devices/register",
            body = DeviceRegistrationRequest(
                deviceId = deviceId,
                deviceName = deviceName
            )
        )
    }

    override suspend fun deleteDevice(deviceId: String): Boolean {
        return apiClient.delete("/api/devices/$deviceId")
    }
}
