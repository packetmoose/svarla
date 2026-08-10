package app.svarla.data.remote.api

import app.svarla.data.remote.dto.DeviceListResponse
import app.svarla.data.remote.dto.DeviceRegistrationResponse

/**
 * API service for device registry management endpoints.
 */
interface DevicesApi {

    /**
     * GET /api/devices — List all registered devices.
     */
    suspend fun getDevices(): DeviceListResponse

    /**
     * POST /api/devices/register — Register device for push notifications.
     * Sends deviceId and deviceName, receives user info and push_topic.
     */
    suspend fun registerDevice(deviceId: String, deviceName: String): DeviceRegistrationResponse

    /**
     * DELETE /api/devices/{deviceId} — Remotely deregister a device.
     */
    suspend fun deleteDevice(deviceId: String): Boolean
}
