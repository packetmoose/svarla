import type { Kysely } from 'kysely';
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
   * Deactivate (deregister) a device by its ID. Returns true if the device was found and deactivated.
   */
  async deactivateDevice(deviceId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('device_registry')
      .set({ is_active: false })
      .where('device_id', '=', deviceId)
      .where('is_active', '=', true)
      .executeTakeFirst();

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
