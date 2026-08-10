import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { DeviceRegistryManager } from '../services/device-registry-manager.js';
import { validatePushEndpointUrl } from '../validators/url-validator.js';

const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid('Invalid device ID format'),
});

const registerDeviceBodySchema = z.object({
  deviceId: z.string().uuid('Invalid device ID format'),
  deviceName: z.string().min(1, 'Device name is required').max(100),
});

const pushEndpointBodySchema = z.object({
  pushEndpointUrl: z.string().url('Invalid push endpoint URL').max(500),
});

export interface DeviceRoutesOptions {
  /** When true, disables SSRF protection on push endpoint URLs (for private LAN setups). */
  pushEndpointSsrfProtection?: boolean;
}

/**
 * Register device management routes.
 */
export function registerDeviceRoutes(
  server: FastifyInstance,
  deviceRegistryManager: DeviceRegistryManager,
  options?: DeviceRoutesOptions
): void {
  const ssrfProtectionEnabled = options?.pushEndpointSsrfProtection ?? true;
  /**
   * GET /api/devices
   * List all active registered devices.
   */
  server.get('/api/devices', async (_request: FastifyRequest, reply: FastifyReply) => {
    const devices = await deviceRegistryManager.listActiveDevices();

    return reply.status(200).send({
      devices: devices.map((d) => ({
        device_id: d.deviceId,
        device_name: d.deviceName,
        push_topic_id: '',
        registered_at: d.registeredAt.toISOString(),
        last_seen_at: d.lastSeenAt.toISOString(),
        is_active: d.isActive,
      })),
    });
  });

  /**
   * POST /api/devices/register
   * Acknowledge device registration. Device provisioning is handled during login.
   * This endpoint is maintained for backward compatibility.
   */
  server.post('/api/devices/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = registerDeviceBodySchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.issues.map((i) => i.message),
        statusCode: 400,
      });
    }

    const { deviceId, deviceName } = parseResult.data;

    return reply.status(200).send({
      device_id: deviceId,
      device_name: deviceName,
    });
  });

  /**
   * PUT /api/devices/:deviceId/push-endpoint
   * Register or update the UnifiedPush endpoint URL for a device.
   * The app calls this after receiving an endpoint from a UnifiedPush distributor.
   */
  server.put('/api/devices/:deviceId/push-endpoint', async (request: FastifyRequest, reply: FastifyReply) => {
    const paramResult = deviceIdParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: paramResult.error.issues.map((i) => i.message),
        statusCode: 400,
      });
    }

    const bodyResult = pushEndpointBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: bodyResult.error.issues.map((i) => i.message),
        statusCode: 400,
      });
    }

    const { deviceId } = paramResult.data;
    const { pushEndpointUrl } = bodyResult.data;

    // SSRF protection: validate the URL resolves to a public IP and uses HTTPS
    const urlValidation = await validatePushEndpointUrl(pushEndpointUrl, {
      skipSsrfProtection: !ssrfProtectionEnabled,
    });
    if (!urlValidation.valid) {
      return reply.status(400).send({
        error: urlValidation.error,
        statusCode: 400,
      });
    }

    const success = await deviceRegistryManager.updatePushEndpoint(deviceId, pushEndpointUrl);

    if (!success) {
      return reply.status(404).send({
        error: 'Device not found or inactive',
        statusCode: 404,
      });
    }

    return reply.status(200).send({
      message: 'Push endpoint registered successfully',
    });
  });

  /**
   * DELETE /api/devices/:deviceId/push-endpoint
   * Remove the UnifiedPush endpoint URL for a device (e.g., on unregister).
   */
  server.delete('/api/devices/:deviceId/push-endpoint', async (request: FastifyRequest, reply: FastifyReply) => {
    const paramResult = deviceIdParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: paramResult.error.issues.map((i) => i.message),
        statusCode: 400,
      });
    }

    const { deviceId } = paramResult.data;
    await deviceRegistryManager.updatePushEndpoint(deviceId, null);

    return reply.status(200).send({
      message: 'Push endpoint removed',
    });
  });

  /**
   * DELETE /api/devices/:deviceId
   * Remotely deregister (deactivate) a device.
   */
  server.delete('/api/devices/:deviceId', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = deviceIdParamSchema.safeParse(request.params);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.issues.map((i) => i.message),
        statusCode: 400,
      });
    }

    const { deviceId } = parseResult.data;
    const success = await deviceRegistryManager.deactivateDevice(deviceId);

    if (!success) {
      return reply.status(404).send({
        error: 'Device not found or already deregistered',
        statusCode: 404,
      });
    }

    return reply.status(200).send({
      message: 'Device deregistered successfully',
    });
  });
}
