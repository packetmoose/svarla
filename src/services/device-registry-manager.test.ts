import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceRegistryManager, DeviceLimitExceededError } from './device-registry-manager.js';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';

interface MockDevice {
  device_id: string;
  device_name: string;
  push_topic_id: string;
  registered_at: Date;
  last_seen_at: Date;
  session_token: string;
  is_active: boolean;
}

function createMockDb() {
  let devices: MockDevice[] = [];

  const mockDb = {
    selectFrom: (table: string) => {
      if (table === 'device_registry') {
        return {
          select: (_selectFn: (eb: unknown) => unknown) => {
            // Handle count query
            return {
              where: (_col: string, _op: string, val: unknown) => ({
                executeTakeFirstOrThrow: async () => {
                  const count = devices.filter((d) => d.is_active === val).length;
                  return { count };
                },
              }),
            };
          },
          selectAll: () => ({
            where: (col: string, _op: string, val: unknown) => {
              const chain: Record<string, unknown> = {
                where: (col2: string, _op2: string, val2: unknown) => ({
                  executeTakeFirst: async () => {
                    return devices.find(
                      (d) =>
                        (col === 'device_id' ? d.device_id === val : true) &&
                        (col2 === 'is_active' ? d.is_active === val2 : true)
                    );
                  },
                }),
                orderBy: (_col2: string, _dir: string) => ({
                  execute: async () => {
                    return devices
                      .filter((d) => (col === 'is_active' ? d.is_active === val : true))
                      .sort((a, b) => b.registered_at.getTime() - a.registered_at.getTime());
                  },
                }),
                execute: async () => {
                  return devices.filter((d) => (col === 'is_active' ? d.is_active === val : true));
                },
                executeTakeFirst: async () => {
                  return devices.find(
                    (d) => (col === 'device_id' ? d.device_id === val : d.is_active === val)
                  );
                },
              };
              return chain;
            },
          }),
        };
      }
      return {};
    },
    insertInto: (table: string) => {
      if (table === 'device_registry') {
        return {
          values: (values: Record<string, unknown>) => ({
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => {
                const newDevice: MockDevice = {
                  device_id: crypto.randomUUID(),
                  device_name: values.device_name as string,
                  push_topic_id: values.push_topic_id as string,
                  registered_at: new Date(),
                  last_seen_at: new Date(),
                  session_token: values.session_token as string,
                  is_active: true,
                };
                devices.push(newDevice);
                return newDevice;
              },
            }),
          }),
        };
      }
      return {};
    },
    updateTable: (table: string) => {
      if (table === 'device_registry') {
        return {
          set: (values: Record<string, unknown>) => ({
            where: (col: string, _op: string, val: unknown) => ({
              where: (col2: string, _op2: string, val2: unknown) => ({
                executeTakeFirst: async () => {
                  const device = devices.find(
                    (d) =>
                      (col === 'device_id' ? d.device_id === val : true) &&
                      (col2 === 'is_active' ? d.is_active === val2 : true)
                  );
                  if (device) {
                    Object.assign(device, values);
                    return { numUpdatedRows: 1n };
                  }
                  return { numUpdatedRows: 0n };
                },
              }),
              execute: async () => {
                const device = devices.find(
                  (d) =>
                    (col === 'device_id' ? d.device_id === val : true) &&
                    d.is_active === true
                );
                if (device) {
                  Object.assign(device, values);
                }
              },
            }),
          }),
        };
      }
      return {};
    },
  } as unknown as Kysely<Database>;

  return { mockDb, getDevices: () => devices, setDevices: (d: MockDevice[]) => { devices = d; } };
}

describe('DeviceRegistryManager', () => {
  let mockDbHelper: ReturnType<typeof createMockDb>;
  let manager: DeviceRegistryManager;

  beforeEach(() => {
    mockDbHelper = createMockDb();
    manager = new DeviceRegistryManager(mockDbHelper.mockDb);
  });

  describe('registerDevice', () => {
    it('should register a device successfully when under limit', async () => {
      const result = await manager.registerDevice({
        deviceName: 'Test Phone',
        pushTopicId: 'topic-abc',
        sessionToken: 'token-123',
      });

      expect(result.deviceId).toBeDefined();
      expect(result.deviceName).toBe('Test Phone');
      expect(result.isActive).toBe(true);
      expect(result.registeredAt).toBeInstanceOf(Date);
      expect(result.lastSeenAt).toBeInstanceOf(Date);
    });

    it('should allow registering up to 5 devices', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await manager.registerDevice({
          deviceName: `Device ${i + 1}`,
          pushTopicId: `topic-${i}`,
          sessionToken: `token-${i}`,
        });
        expect(result.deviceId).toBeDefined();
      }

      expect(mockDbHelper.getDevices()).toHaveLength(5);
    });

    it('should throw DeviceLimitExceededError when at max capacity', async () => {
      // Register 5 devices
      for (let i = 0; i < 5; i++) {
        await manager.registerDevice({
          deviceName: `Device ${i + 1}`,
          pushTopicId: `topic-${i}`,
          sessionToken: `token-${i}`,
        });
      }

      // 6th should fail
      await expect(
        manager.registerDevice({
          deviceName: 'Device 6',
          pushTopicId: 'topic-6',
          sessionToken: 'token-6',
        })
      ).rejects.toThrow(DeviceLimitExceededError);

      expect(mockDbHelper.getDevices()).toHaveLength(5);
    });

    it('should allow registration after a device is deactivated', async () => {
      // Register 5 devices
      for (let i = 0; i < 5; i++) {
        await manager.registerDevice({
          deviceName: `Device ${i + 1}`,
          pushTopicId: `topic-${i}`,
          sessionToken: `token-${i}`,
        });
      }

      // Deactivate one
      const devices = mockDbHelper.getDevices();
      await manager.deactivateDevice(devices[0].device_id);

      // Now should be able to register a new one
      const result = await manager.registerDevice({
        deviceName: 'Replacement Device',
        pushTopicId: 'topic-new',
        sessionToken: 'token-new',
      });

      expect(result.deviceId).toBeDefined();
      expect(result.deviceName).toBe('Replacement Device');
    });
  });

  describe('listActiveDevices', () => {
    it('should return empty array when no devices registered', async () => {
      const devices = await manager.listActiveDevices();
      expect(devices).toEqual([]);
    });

    it('should return only active devices', async () => {
      await manager.registerDevice({
        deviceName: 'Active Device',
        pushTopicId: 'topic-1',
        sessionToken: 'token-1',
      });
      await manager.registerDevice({
        deviceName: 'Device To Deactivate',
        pushTopicId: 'topic-2',
        sessionToken: 'token-2',
      });

      // Deactivate one
      const allDevices = mockDbHelper.getDevices();
      await manager.deactivateDevice(allDevices[1].device_id);

      const active = await manager.listActiveDevices();
      expect(active).toHaveLength(1);
      expect(active[0].deviceName).toBe('Active Device');
    });

    it('should return devices with all required fields', async () => {
      await manager.registerDevice({
        deviceName: 'My Phone',
        pushTopicId: 'topic-abc',
        sessionToken: 'token-xyz',
      });

      const devices = await manager.listActiveDevices();
      expect(devices[0]).toHaveProperty('deviceId');
      expect(devices[0]).toHaveProperty('deviceName');
      expect(devices[0]).toHaveProperty('registeredAt');
      expect(devices[0]).toHaveProperty('lastSeenAt');
      expect(devices[0]).toHaveProperty('isActive');
    });
  });

  describe('deactivateDevice', () => {
    it('should deactivate an active device', async () => {
      const registered = await manager.registerDevice({
        deviceName: 'My Device',
        pushTopicId: 'topic-1',
        sessionToken: 'token-1',
      });

      const result = await manager.deactivateDevice(registered.deviceId);
      expect(result).toBe(true);

      const devices = mockDbHelper.getDevices();
      expect(devices[0].is_active).toBe(false);
    });

    it('should return false for non-existent device', async () => {
      const result = await manager.deactivateDevice('00000000-0000-0000-0000-000000000000');
      expect(result).toBe(false);
    });

    it('should return false for already deactivated device', async () => {
      const registered = await manager.registerDevice({
        deviceName: 'My Device',
        pushTopicId: 'topic-1',
        sessionToken: 'token-1',
      });

      await manager.deactivateDevice(registered.deviceId);
      const secondAttempt = await manager.deactivateDevice(registered.deviceId);
      expect(secondAttempt).toBe(false);
    });
  });

  describe('getActiveDeviceCount', () => {
    it('should return 0 when no devices are registered', async () => {
      const count = await manager.getActiveDeviceCount();
      expect(count).toBe(0);
    });

    it('should count only active devices', async () => {
      await manager.registerDevice({
        deviceName: 'Device 1',
        pushTopicId: 'topic-1',
        sessionToken: 'token-1',
      });
      await manager.registerDevice({
        deviceName: 'Device 2',
        pushTopicId: 'topic-2',
        sessionToken: 'token-2',
      });

      const devices = mockDbHelper.getDevices();
      await manager.deactivateDevice(devices[0].device_id);

      const count = await manager.getActiveDeviceCount();
      expect(count).toBe(1);
    });
  });

  describe('getDevice', () => {
    it('should return device info for an active device', async () => {
      const registered = await manager.registerDevice({
        deviceName: 'My Device',
        pushTopicId: 'topic-1',
        sessionToken: 'token-1',
      });

      const device = await manager.getDevice(registered.deviceId);
      expect(device).not.toBeNull();
      expect(device!.deviceId).toBe(registered.deviceId);
      expect(device!.deviceName).toBe('My Device');
    });

    it('should return null for non-existent device', async () => {
      const device = await manager.getDevice('00000000-0000-0000-0000-000000000000');
      expect(device).toBeNull();
    });

    it('should return null for deactivated device', async () => {
      const registered = await manager.registerDevice({
        deviceName: 'My Device',
        pushTopicId: 'topic-1',
        sessionToken: 'token-1',
      });

      await manager.deactivateDevice(registered.deviceId);
      const device = await manager.getDevice(registered.deviceId);
      expect(device).toBeNull();
    });
  });
});
