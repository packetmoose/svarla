import type { Kysely } from 'kysely';
import crypto from 'node:crypto';
import type { Database } from '../database.js';

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  registeredAt: Date;
  lastSeenAt: Date;
  isActive: boolean;
}

export interface RegisterDeviceParams {
  deviceName: string;
  pushTopicId: string;
  sessionToken: string;
  /** When true, skip the active device limit check (used for web browser sessions). */
  skipDeviceLimit?: boolean;
}

export class DeviceLimitExceededError extends Error {
  constructor() {
    super('Maximum device limit (5) reached. Please deregister an existing device first.');
    this.name = 'DeviceLimitExceededError';
  }
}

const MAX_ACTIVE_DEVICES = 5;

/**
 * DeviceRegistryManager handles CRUD operations for registered devices,
 * enforces the max 5 active devices limit, and tracks device connectivity.
 */
export class DeviceRegistryManager {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  /**
   * Get the count of currently active devices.
   */
  async getActiveDeviceCount(): Promise<number> {
    const result = await this.db
      .selectFrom('device_registry')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('is_active', '=', true)
      .executeTakeFirstOrThrow();

    return Number(result.count);
  }

  /**
   * Register a new device. Throws DeviceLimitExceededError if at max capacity (5).
   * If params.skipDeviceLimit is true, the limit check is skipped (used for web browser sessions).
   */
  async registerDevice(params: RegisterDeviceParams): Promise<DeviceInfo> {
    if (!params.skipDeviceLimit) {
      const activeCount = await this.getActiveDeviceCount();

      if (activeCount >= MAX_ACTIVE_DEVICES) {
        throw new DeviceLimitExceededError();
      }
    }

    const result = await this.db
      .insertInto('device_registry')
      .values({
        device_name: params.deviceName,
        push_topic_id: params.pushTopicId,
        session_token: params.sessionToken,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      deviceId: result.device_id,
      deviceName: result.device_name,
      registeredAt: result.registered_at,
      lastSeenAt: result.last_seen_at,
      isActive: result.is_active,
    };
  }

  /**
   * List all active registered devices.
   */
  async listActiveDevices(): Promise<DeviceInfo[]> {
    const devices = await this.db
      .selectFrom('device_registry')
      .selectAll()
      .where('is_active', '=', true)
      .orderBy('registered_at', 'desc')
      .execute();

    return devices.map((d) => ({
      deviceId: d.device_id,
      deviceName: d.device_name,
      registeredAt: d.registered_at,
      lastSeenAt: d.last_seen_at,
      isActive: d.is_active,
    }));
  }

  /**
   * Deactivate a device by its ID. Returns true if a row was updated.
   *
   * Two distinct callers with opposite intent share this method:
   *
   * - The WebDeviceReaper marks orphaned browser devices *dormant*. Their
   *   session token must survive so the holder can reactivate on return
   *   (see AuthService.validateSession). This is the default: `is_active`
   *   flips to false, the token is left intact, and only currently-active
   *   rows are touched.
   *
   * - Intentional deregistration (the DELETE /api/devices/:id endpoint) must
   *   *permanently* end the session: its token has to be rejected on all
   *   subsequent requests (design Property 15). Pass `invalidateToken: true`
   *   to also rotate `session_token` to an unusable sentinel. In that mode we
   *   match regardless of `is_active`, so a device the reaper already marked
   *   dormant can still be fully removed.
   */
  async deactivateDevice(
    deviceId: string,
    options?: { invalidateToken?: boolean }
  ): Promise<boolean> {
    const invalidateToken = options?.invalidateToken ?? false;

    let query = this.db
      .updateTable('device_registry')
      .set(
        invalidateToken
          ? {
              is_active: false,
              // `session_token` is NOT NULL UNIQUE — use a random, namespaced
              // value that no client holds and cannot collide with a real token.
              session_token: `removed:${crypto.randomBytes(32).toString('hex')}`,
            }
          : { is_active: false }
      )
      .where('device_id', '=', deviceId);

    // Dormancy toggles only currently-active rows; token invalidation must also
    // reach already-dormant rows to guarantee Property 15.
    if (!invalidateToken) {
      query = query.where('is_active', '=', true);
    }

    const result = await query.executeTakeFirst();

    return (result?.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Update the last_seen_at timestamp for a device.
   */
  async updateLastSeen(deviceId: string): Promise<void> {
    await this.db
      .updateTable('device_registry')
      .set({ last_seen_at: new Date() })
      .where('device_id', '=', deviceId)
      .where('is_active', '=', true)
      .execute();
  }

  /**
   * Get a single device by its ID (only if active).
   */
  async getDevice(deviceId: string): Promise<DeviceInfo | null> {
    const device = await this.db
      .selectFrom('device_registry')
      .selectAll()
      .where('device_id', '=', deviceId)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!device) {
      return null;
    }

    return {
      deviceId: device.device_id,
      deviceName: device.device_name,
      registeredAt: device.registered_at,
      lastSeenAt: device.last_seen_at,
      isActive: device.is_active,
    };
  }

  /**
   * Update the UnifiedPush endpoint URL for a device.
   * Returns true if the device was found and updated.
   */
  async updatePushEndpoint(deviceId: string, pushEndpointUrl: string | null): Promise<boolean> {
    const result = await this.db
      .updateTable('device_registry')
      .set({ push_endpoint_url: pushEndpointUrl })
      .where('device_id', '=', deviceId)
      .where('is_active', '=', true)
      .executeTakeFirst();

    return (result?.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Get the push endpoint URL for a device (for UnifiedPush delivery).
   * Returns null if no endpoint is registered.
   */
  async getPushEndpointUrl(deviceId: string): Promise<string | null> {
    const device = await this.db
      .selectFrom('device_registry')
      .select('push_endpoint_url')
      .where('device_id', '=', deviceId)
      .where('is_active', '=', true)
      .executeTakeFirst();

    return device?.push_endpoint_url ?? null;
  }

  /**
   * Get all active devices with their push info for notification delivery.
   */
  async getActiveDevicesWithPushInfo(): Promise<Array<{
    deviceId: string;
    pushEndpointUrl: string | null;
  }>> {
    const devices = await this.db
      .selectFrom('device_registry')
      .select(['device_id', 'push_endpoint_url'])
      .where('is_active', '=', true)
      .execute();

    return devices.map((d) => ({
      deviceId: d.device_id,
      pushEndpointUrl: d.push_endpoint_url,
    }));
  }
}
