import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerDeviceRoutes } from './device-routes.js';
import type { DeviceRegistryManager, DeviceInfo } from '../services/device-registry-manager.js';

function createMockDeviceRegistryManager(): DeviceRegistryManager {
  const mockDevices: DeviceInfo[] = [
    {
      deviceId: '11111111-1111-1111-1111-111111111111',
      deviceName: 'Phone 1',
      registeredAt: new Date('2024-01-01T10:00:00Z'),
      lastSeenAt: new Date('2024-01-15T12:00:00Z'),
      isActive: true,
    },
    {
      deviceId: '22222222-2222-2222-2222-222222222222',
      deviceName: 'Tablet',
      registeredAt: new Date('2024-01-05T08:00:00Z'),
      lastSeenAt: new Date('2024-01-14T09:30:00Z'),
      isActive: true,
    },
  ];

  return {
    listActiveDevices: vi.fn().mockResolvedValue(mockDevices),
    deactivateDevice: vi.fn().mockImplementation(async (deviceId: string) => {
      return mockDevices.some((d) => d.deviceId === deviceId);
    }),
    registerDevice: vi.fn(),
    getActiveDeviceCount: vi.fn(),
    updateLastSeen: vi.fn(),
    getDevice: vi.fn(),
  } as unknown as DeviceRegistryManager;
}

describe('Device Routes', () => {
  let server: FastifyInstance;
  let mockManager: DeviceRegistryManager;

  beforeEach(async () => {
    server = Fastify();
    mockManager = createMockDeviceRegistryManager();
    registerDeviceRoutes(server, mockManager);
    await server.ready();
  });

  describe('GET /api/devices', () => {
    it('should return a list of active devices', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/devices',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.devices).toHaveLength(2);
      expect(body.devices[0]).toEqual({
        device_id: '11111111-1111-1111-1111-111111111111',
        device_name: 'Phone 1',
        push_topic_id: '',
        registered_at: '2024-01-01T10:00:00.000Z',
        last_seen_at: '2024-01-15T12:00:00.000Z',
        is_active: true,
      });
      expect(body.devices[1]).toEqual({
        device_id: '22222222-2222-2222-2222-222222222222',
        device_name: 'Tablet',
        push_topic_id: '',
        registered_at: '2024-01-05T08:00:00.000Z',
        last_seen_at: '2024-01-14T09:30:00.000Z',
        is_active: true,
      });
    });

    it('should return empty devices array when no devices are registered', async () => {
      vi.mocked(mockManager.listActiveDevices).mockResolvedValue([]);

      const response = await server.inject({
        method: 'GET',
        url: '/api/devices',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.devices).toEqual([]);
    });
  });

  describe('DELETE /api/devices/:deviceId', () => {
    it('should deregister a device successfully', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: '/api/devices/11111111-1111-1111-1111-111111111111',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.message).toBe('Device deregistered successfully');
      expect(mockManager.deactivateDevice).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    });

    it('should return 404 for non-existent device', async () => {
      vi.mocked(mockManager.deactivateDevice).mockResolvedValue(false);

      const response = await server.inject({
        method: 'DELETE',
        url: '/api/devices/99999999-9999-9999-9999-999999999999',
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe('Device not found or already deregistered');
    });

    it('should return 400 for invalid device ID format', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: '/api/devices/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('Validation failed');
    });
  });
});
