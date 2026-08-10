import { describe, it, expect, beforeEach } from 'vitest';
import { AuthService } from './auth-service.js';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import bcrypt from 'bcrypt';

// In-memory test using mocked Kysely database interactions

import { vi } from 'vitest';

function createTestAuthService() {
  const mockPassword = 'Correct$Pass1';
  let passwordHash: string;
  let authRow: { id: number; password_hash: string; failed_attempts: number; locked_until: Date | null };
  let devices: Array<{
    device_id: string;
    device_name: string;
    push_topic_id: string;
    registered_at: Date;
    last_seen_at: Date;
    session_token: string;
    is_active: boolean;
  }> = [];

  // Create a mock Kysely instance that proxies operations
  const mockDb = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === 'auth') {
        return {
          selectAll: () => ({
            where: (_col: string, _op: string, _val: unknown) => ({
              executeTakeFirst: async () => authRow,
            }),
          }),
        };
      }
      if (table === 'device_registry') {
        return {
          select: () => ({
            where: (_col: string, _op: string, val: unknown) => ({
              executeTakeFirstOrThrow: async () => {
                const count = devices.filter((d) => d.is_active === val).length;
                return { count };
              },
            }),
          }),
          selectAll: () => ({
            where: (col: string, _op: string, val: unknown) => {
              const chain = {
                where: (col2: string, _op2: string, val2: unknown) => ({
                  executeTakeFirst: async () => {
                    return devices.find(
                      (d) =>
                        (col === 'session_token' ? d.session_token === val : true) &&
                        (col2 === 'is_active' ? d.is_active === val2 : true)
                    );
                  },
                }),
                executeTakeFirst: async () => {
                  return devices.find(
                    (d) => (col === 'session_token' ? d.session_token === val : true)
                  );
                },
              };
              return chain;
            },
          }),
        };
      }
      return {};
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      return {
        set: (values: Record<string, unknown>) => ({
          where: (col: string, _op: string, val: unknown) => ({
            where: (col2?: string, _op2?: string, val2?: unknown) => ({
              executeTakeFirst: async () => {
                if (table === 'auth') {
                  Object.assign(authRow, values);
                  return { numUpdatedRows: 1n };
                }
                if (table === 'device_registry') {
                  const device = devices.find(
                    (d) =>
                      (col === 'session_token' ? d.session_token === val : col === 'device_id' ? d.device_id === val : true) &&
                      (col2 === 'is_active' ? d.is_active === val2 : true)
                  );
                  if (device) {
                    Object.assign(device, values);
                    return { numUpdatedRows: 1n };
                  }
                  return { numUpdatedRows: 0n };
                }
                return { numUpdatedRows: 0n };
              },
            }),
            execute: async () => {
              if (table === 'auth') {
                Object.assign(authRow, values);
              }
              if (table === 'device_registry') {
                const device = devices.find(
                  (d) => (col === 'device_id' ? d.device_id === val : d.session_token === val)
                );
                if (device) {
                  Object.assign(device, values);
                }
              }
            },
            executeTakeFirst: async () => {
              if (table === 'auth') {
                Object.assign(authRow, values);
                return { numUpdatedRows: 1n };
              }
              if (table === 'device_registry') {
                const device = devices.find(
                  (d) => (col === 'session_token' ? d.session_token === val : d.device_id === val)
                );
                if (device) {
                  Object.assign(device, values);
                  return { numUpdatedRows: 1n };
                }
                return { numUpdatedRows: 0n };
              }
              return { numUpdatedRows: 0n };
            },
          }),
        }),
      };
    }),
    insertInto: vi.fn().mockImplementation((table: string) => {
      return {
        values: (values: Record<string, unknown>) => ({
          execute: async () => {
            if (table === 'device_registry') {
              devices.push({
                device_id: crypto.randomUUID(),
                device_name: values.device_name as string,
                push_topic_id: values.push_topic_id as string,
                registered_at: new Date(),
                last_seen_at: new Date(),
                session_token: values.session_token as string,
                is_active: values.is_active as boolean ?? true,
              });
            }
          },
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              if (table === 'device_registry') {
                const newDevice = {
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
              }
            },
          }),
        }),
      };
    }),
  } as unknown as Kysely<Database>;

  return {
    mockDb,
    devices,
    mockPassword,
    async setup() {
      passwordHash = await bcrypt.hash(mockPassword, 10);
      authRow = {
        id: 1,
        password_hash: passwordHash,
        failed_attempts: 0,
        locked_until: null,
      };
      devices = [];
    },
    getAuthRow: () => authRow,
    setAuthRow: (row: typeof authRow) => { authRow = row; },
    getDevices: () => devices,
  };
}

describe('AuthService', () => {
  let testHelper: ReturnType<typeof createTestAuthService>;
  let authService: AuthService;

  beforeEach(async () => {
    testHelper = createTestAuthService();
    await testHelper.setup();
    authService = new AuthService(testHelper.mockDb, {
      sessionExpiryDays: 30,
      maxFailedAttempts: 5,
      lockoutDurationMinutes: 15,
    });
  });

  describe('login', () => {
    it('should succeed with correct password', async () => {
      const result = await authService.login(
        testHelper.mockPassword,
        'Test Device',
        'topic-123'
      );

      expect(result.success).toBe(true);
      expect(result.sessionToken).toBeDefined();
      expect(result.sessionToken).toHaveLength(64); // 32 bytes in hex
      expect(result.error).toBeUndefined();
    });

    it('should fail with incorrect password', async () => {
      const result = await authService.login(
        'WrongPassword1!',
        'Test Device',
        'topic-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid password');
      expect(result.sessionToken).toBeUndefined();
    });

    it('should increment failed attempts on wrong password', async () => {
      await authService.login('WrongPassword1!', 'Test Device', 'topic-123');

      expect(testHelper.getAuthRow().failed_attempts).toBe(1);
    });

    it('should lock account after 5 failed attempts', async () => {
      for (let i = 0; i < 5; i++) {
        await authService.login('WrongPassword1!', 'Test Device', 'topic-123');
      }

      const authRow = testHelper.getAuthRow();
      expect(authRow.failed_attempts).toBe(5);
      expect(authRow.locked_until).not.toBeNull();
      expect(authRow.locked_until!.getTime()).toBeGreaterThan(Date.now());
    });

    it('should reject login when account is locked', async () => {
      const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
      testHelper.setAuthRow({
        id: 1,
        password_hash: testHelper.getAuthRow().password_hash,
        failed_attempts: 5,
        locked_until: lockedUntil,
      });

      const result = await authService.login(
        testHelper.mockPassword,
        'Test Device',
        'topic-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('locked');
      expect(result.lockedUntil).toEqual(lockedUntil);
    });

    it('should allow login after lockout expires', async () => {
      const expiredLock = new Date(Date.now() - 1000); // 1 second in the past
      testHelper.setAuthRow({
        id: 1,
        password_hash: testHelper.getAuthRow().password_hash,
        failed_attempts: 5,
        locked_until: expiredLock,
      });

      const result = await authService.login(
        testHelper.mockPassword,
        'Test Device',
        'topic-123'
      );

      expect(result.success).toBe(true);
      expect(result.sessionToken).toBeDefined();
    });

    it('should reset failed attempts on successful login', async () => {
      // First fail some attempts
      await authService.login('WrongPassword1!', 'Test Device', 'topic-123');
      await authService.login('WrongPassword1!', 'Test Device', 'topic-123');
      expect(testHelper.getAuthRow().failed_attempts).toBe(2);

      // Then succeed
      await authService.login(testHelper.mockPassword, 'Test Device', 'topic-123');
      expect(testHelper.getAuthRow().failed_attempts).toBe(0);
    });

    it('should register a device on successful login', async () => {
      await authService.login(testHelper.mockPassword, 'My Phone', 'push-topic');

      const devices = testHelper.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].device_name).toBe('My Phone');
      // Server generates a random UUID for push_topic_id (ignores client-supplied value)
      expect(devices[0].push_topic_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(devices[0].is_active).toBe(true);
    });

    it('should generate unique session tokens per login', async () => {
      const result1 = await authService.login(
        testHelper.mockPassword,
        'Device 1',
        'topic-1'
      );
      const result2 = await authService.login(
        testHelper.mockPassword,
        'Device 2',
        'topic-2'
      );

      expect(result1.sessionToken).not.toBe(result2.sessionToken);
    });
  });

  describe('logout', () => {
    it('should deactivate device on logout', async () => {
      const loginResult = await authService.login(
        testHelper.mockPassword,
        'Test Device',
        'topic-123'
      );

      const success = await authService.logout(loginResult.sessionToken!);

      expect(success).toBe(true);
      const devices = testHelper.getDevices();
      expect(devices[0].is_active).toBe(false);
    });

    it('should return false for invalid token', async () => {
      const success = await authService.logout('nonexistent-token');
      expect(success).toBe(false);
    });
  });

  describe('validateSession', () => {
    it('should validate an active session', async () => {
      const loginResult = await authService.login(
        testHelper.mockPassword,
        'Test Device',
        'topic-123'
      );

      const session = await authService.validateSession(loginResult.sessionToken!);

      expect(session.valid).toBe(true);
      expect(session.deviceId).toBeDefined();
      expect(session.deviceName).toBe('Test Device');
    });

    it('should reject an invalid token', async () => {
      const session = await authService.validateSession('nonexistent-token');
      expect(session.valid).toBe(false);
    });

    it('should reject an expired session', async () => {
      // Login and then backdate the registration
      const loginResult = await authService.login(
        testHelper.mockPassword,
        'Test Device',
        'topic-123'
      );

      const devices = testHelper.getDevices();
      // Set registered_at to 31 days ago
      devices[0].registered_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

      const session = await authService.validateSession(loginResult.sessionToken!);
      expect(session.valid).toBe(false);
    });

    it('should reject a deactivated session', async () => {
      const loginResult = await authService.login(
        testHelper.mockPassword,
        'Test Device',
        'topic-123'
      );

      await authService.logout(loginResult.sessionToken!);
      const session = await authService.validateSession(loginResult.sessionToken!);
      expect(session.valid).toBe(false);
    });
  });

  describe('hashPassword', () => {
    it('should generate a valid bcrypt hash', async () => {
      const hash = await authService.hashPassword('TestPassword123!');
      expect(hash).toMatch(/^\$2[aby]\$/);
      const isValid = await bcrypt.compare('TestPassword123!', hash);
      expect(isValid).toBe(true);
    });
  });
});
