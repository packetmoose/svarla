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
   * Logout: permanently invalidate the session token and deactivate the device.
   *
   * Unlike the reaper (which only marks a device dormant and leaves its token
   * intact so it can reactivate), logout must ensure the token can NEVER
   * validate again. We therefore rotate `session_token` to an unusable sentinel
   * in addition to deactivating the device. Matching is by token alone — a
   * dormant (reaper-deactivated) device still holds a valid token and must be
   * logoutable, so we do not filter on `is_active` here.
   */
  async logout(sessionToken: string): Promise<boolean> {
    // `session_token` is NOT NULL, so we replace it with a random, namespaced
    // value that no client holds and that can never collide with a real token.
    const invalidatedToken = `logged-out:${crypto.randomBytes(32).toString('hex')}`;

    const result = await this.db
      .updateTable('device_registry')
      .set({ is_active: false, session_token: invalidatedToken })
      .where('session_token', '=', sessionToken)
      .executeTakeFirst();

    return (result?.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Validate a session token. Returns the device info if valid.
   *
   * A session is valid if:
   * - The token exists in device_registry
   * - The session hasn't expired (registered_at + sessionExpiryDays > now)
   *
   * Note: validity is deliberately NOT gated on `is_active`. The WebDeviceReaper
   * marks orphaned browser devices inactive ("dormant") after their socket goes
   * away, but that must not invalidate an otherwise-valid session token. A
   * returning holder of a still-valid token reactivates its own device here,
   * so a dropped WebSocket (sleep, wifi blip, backgrounded tab) no longer forces
   * a re-login. Only true 30-day expiry — or an explicit logout, which rotates
   * the token to an unusable value — ends the session.
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

    // Token is within its validity window. Refresh last_seen and reactivate the
    // device if the reaper had marked it dormant (is_active = false). Both are
    // applied in a single update.
    await this.db
      .updateTable('device_registry')
      .set({ last_seen_at: new Date(), is_active: true })
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
