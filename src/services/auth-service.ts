import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import { DeviceRegistryManager, DeviceLimitExceededError } from './device-registry-manager.js';

export interface LoginResult {
  success: boolean;
  sessionToken?: string;
  deviceId?: string;
  pushTopicId?: string;
  error?: string;
  lockedUntil?: Date;
}

export interface AuthServiceConfig {
  sessionExpiryDays: number;
  maxFailedAttempts?: number;
  lockoutDurationMinutes?: number;
}

const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_DURATION_MINUTES = 15;
const BCRYPT_SALT_ROUNDS = 12;

/**
 * AuthService handles password validation, session token management,
 * and account lockout logic.
 */
export class AuthService {
  private readonly db: Kysely<Database>;
  private readonly deviceRegistryManager: DeviceRegistryManager;
  private readonly sessionExpiryDays: number;
  private readonly maxFailedAttempts: number;
  private readonly lockoutDurationMinutes: number;

  constructor(db: Kysely<Database>, config: AuthServiceConfig) {
    this.db = db;
    this.deviceRegistryManager = new DeviceRegistryManager(db);
    this.sessionExpiryDays = config.sessionExpiryDays;
    this.maxFailedAttempts = config.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
    this.lockoutDurationMinutes = config.lockoutDurationMinutes ?? DEFAULT_LOCKOUT_DURATION_MINUTES;
  }

  /**
   * Attempt login with the provided password and device info.
   * On success, registers the device and returns a session token.
   */
  async login(
    password: string,
    deviceName: string,
    _pushTopicId: string,
    options?: { skipDeviceLimit?: boolean }
  ): Promise<LoginResult> {
    const auth = await this.db
      .selectFrom('auth')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirst();

    if (!auth) {
      return { success: false, error: 'Authentication not configured' };
    }

    // Check if account is locked
    if (auth.locked_until) {
      const now = new Date();
      if (auth.locked_until > now) {
        return {
          success: false,
          error: 'Account is locked due to too many failed attempts',
          lockedUntil: auth.locked_until,
        };
      }
      // Lockout period expired — reset
      await this.db
        .updateTable('auth')
        .set({ failed_attempts: 0, locked_until: null })
        .where('id', '=', 1)
        .execute();
    }

    // Validate password
    const passwordValid = await bcrypt.compare(password, auth.password_hash);

    if (!passwordValid) {
      const newAttempts = auth.failed_attempts + 1;

      if (newAttempts >= this.maxFailedAttempts) {
        // Lock the account
        const lockedUntil = new Date(
          Date.now() + this.lockoutDurationMinutes * 60 * 1000
        );
        await this.db
          .updateTable('auth')
          .set({ failed_attempts: newAttempts, locked_until: lockedUntil })
          .where('id', '=', 1)
          .execute();
        return {
          success: false,
          error: 'Account is locked due to too many failed attempts',
          lockedUntil,
        };
      }

      await this.db
        .updateTable('auth')
        .set({ failed_attempts: newAttempts })
        .where('id', '=', 1)
        .execute();

      return {
        success: false,
        error: 'Invalid password',
      };
    }

    // Password valid — reset failed attempts
    await this.db
      .updateTable('auth')
      .set({ failed_attempts: 0, locked_until: null })
      .where('id', '=', 1)
      .execute();

    // Generate session token
    const sessionToken = crypto.randomBytes(32).toString('hex');

    // Generate a unique push topic for this device (used as an identifier)
    // We ignore the client-supplied pushTopicId and generate our own secure random one
    const serverPushTopicId = crypto.randomUUID();

    // Register device via DeviceRegistryManager (enforces max 5 limit)
    try {
      const device = await this.deviceRegistryManager.registerDevice({
        deviceName,
        pushTopicId: serverPushTopicId,
        sessionToken,
        skipDeviceLimit: options?.skipDeviceLimit,
      });

      return { success: true, sessionToken, deviceId: device.deviceId, pushTopicId: serverPushTopicId };
    } catch (error) {
      if (error instanceof DeviceLimitExceededError) {
        return {
          success: false,
          error: error.message,
        };
      }
      throw error;
    }
  }

  /**
   * Logout: invalidate the session token by deactivating the device.
   */
  async logout(sessionToken: string): Promise<boolean> {
    const result = await this.db
      .updateTable('device_registry')
      .set({ is_active: false })
      .where('session_token', '=', sessionToken)
      .where('is_active', '=', true)
      .executeTakeFirst();

    return (result?.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Validate a session token. Returns the device info if valid.
   * A session is valid if:
   * - The token exists in device_registry
   * - The device is active
   * - The session hasn't expired (registered_at + sessionExpiryDays > now)
   */
  async validateSession(sessionToken: string): Promise<{
    valid: boolean;
    deviceId?: string;
    deviceName?: string;
  }> {
    const device = await this.db
      .selectFrom('device_registry')
      .selectAll()
      .where('session_token', '=', sessionToken)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!device) {
      return { valid: false };
    }

    // Check session expiry
    const expiresAt = new Date(device.registered_at);
    expiresAt.setDate(expiresAt.getDate() + this.sessionExpiryDays);

    if (new Date() > expiresAt) {
      // Session expired — deactivate
      await this.db
        .updateTable('device_registry')
        .set({ is_active: false })
        .where('device_id', '=', device.device_id)
        .execute();
      return { valid: false };
    }

    // Update last_seen_at
    await this.db
      .updateTable('device_registry')
      .set({ last_seen_at: new Date() })
      .where('device_id', '=', device.device_id)
      .execute();

    return {
      valid: true,
      deviceId: device.device_id,
      deviceName: device.device_name,
    };
  }

  /**
   * Hash a password using bcrypt. Used for initial setup or password changes.
   */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  }

  /**
   * Retrieve the auth record (password hash) for password verification.
   */
  async getAuth(): Promise<{ passwordHash: string } | null> {
    const auth = await this.db
      .selectFrom('auth')
      .select('password_hash')
      .where('id', '=', 1)
      .executeTakeFirst();

    if (!auth) {
      return null;
    }

    return { passwordHash: auth.password_hash };
  }

  /**
   * Update the stored password hash. Used during password change.
   */
  async updatePasswordHash(newHash: string): Promise<void> {
    await this.db
      .updateTable('auth')
      .set({ password_hash: newHash })
      .where('id', '=', 1)
      .execute();
  }
}
