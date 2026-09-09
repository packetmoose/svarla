import type { DeviceInfo, DeviceRegistryManager } from './device-registry-manager.js';
import type { WebSocketBroadcaster } from '../websocket/broadcaster.js';
import type { CallOrchestrator } from './call-orchestrator.js';

/**
 * The device name assigned to browser sessions at login (see auth-routes.ts).
 * Devices registered under this name (equivalently, with the `skipDeviceLimit`
 * flag) are the only devices the reaper is allowed to deactivate.
 */
export const WEB_BROWSER_DEVICE_NAME = 'Web Browser';

/** Default staleness window: a small multiple of the broadcaster's 30s ping. */
export const DEFAULT_WEB_DEVICE_STALENESS_MS = 90_000;

/**
 * The subset of {@link DeviceRegistryManager} the reaper depends on. Declaring
 * it structurally keeps the reaper composable and trivially mockable in tests.
 */
export interface ReaperRegistry {
  listActiveDevices(): Promise<DeviceInfo[]>;
  updateLastSeen(deviceId: string): Promise<void>;
  deactivateDevice(deviceId: string): Promise<boolean>;
}

/** The subset of {@link WebSocketBroadcaster} the reaper depends on. */
export interface ReaperBroadcaster {
  isDeviceConnected(deviceId: string): boolean;
  getConnectedDeviceIds(): Set<string>;
}

/** The subset of {@link CallOrchestrator} the reaper depends on. */
export interface ReaperOrchestrator {
  getActiveDeviceIds(): Set<string>;
}

export interface WebDeviceReaperDeps {
  registry: ReaperRegistry;
  broadcaster: ReaperBroadcaster;
  orchestrator: ReaperOrchestrator;
  /** Staleness interval in milliseconds. Defaults to {@link DEFAULT_WEB_DEVICE_STALENESS_MS}. */
  stalenessMs?: number;
  /** Injectable clock for testability. Defaults to `() => Date.now()`. */
  now?: () => number;
}

/**
 * WebDeviceReaper deactivates orphaned browser devices and keeps connected
 * browser devices fresh. It composes existing building blocks
 * (`DeviceRegistryManager`, the broadcaster's read accessors, and the
 * orchestrator's active-call accessor) and adds no new persistence.
 *
 * Behavior (Requirement 13):
 * - While a Web_Device has a live socket, its last-seen is refreshed so it is
 *   never considered stale (13.1).
 * - A Web_Device is reaped only when ALL of the following hold:
 *     - it is web-registered (`Web Browser` / `skipDeviceLimit`) (13.4)
 *     - it has no live socket (13.2)
 *     - it is stale beyond the staleness interval (13.2)
 *     - it is NOT associated with an active call (13.7)
 * - Android/push devices and every other device or in-progress call are left
 *   untouched (13.4, 13.6).
 */
export class WebDeviceReaper {
  private readonly registry: ReaperRegistry;
  private readonly broadcaster: ReaperBroadcaster;
  private readonly orchestrator: ReaperOrchestrator;
  private readonly stalenessMs: number;
  private readonly now: () => number;

  constructor(deps: WebDeviceReaperDeps) {
    this.registry = deps.registry;
    this.broadcaster = deps.broadcaster;
    this.orchestrator = deps.orchestrator;
    this.stalenessMs = deps.stalenessMs ?? DEFAULT_WEB_DEVICE_STALENESS_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Determine whether a device is a web-registered browser device that the
   * reaper is permitted to touch. Android/push devices never qualify.
   */
  private isWebDevice(device: DeviceInfo): boolean {
    return device.deviceName === WEB_BROWSER_DEVICE_NAME;
  }

  /**
   * Perform one sweep of the device registry.
   *
   * For every currently active device:
   * - If it is a web device WITH a live socket, refresh its last-seen (13.1).
   * - If it is a web device with NO live socket that is stale beyond the
   *   staleness interval and is not associated with an active call, deactivate
   *   it (13.2, 13.3, 13.7).
   * - All other devices (Android/push, connected, fresh, or in-call) are left
   *   untouched (13.4, 13.6).
   *
   * Returns the list of device IDs that were deactivated this sweep.
   */
  async sweep(): Promise<string[]> {
    const devices = await this.registry.listActiveDevices();
    const activeCallDeviceIds = this.orchestrator.getActiveDeviceIds();
    const now = this.now();

    const reaped: string[] = [];

    for (const device of devices) {
      // Never touch Android/push devices (13.4).
      if (!this.isWebDevice(device)) continue;

      const hasLiveSocket = this.broadcaster.isDeviceConnected(device.deviceId);

      // While a Web_Device has a live socket, keep it fresh (13.1).
      if (hasLiveSocket) {
        await this.registry.updateLastSeen(device.deviceId);
        continue;
      }

      // No live socket: only reap when stale beyond the interval (13.2).
      const ageMs = now - device.lastSeenAt.getTime();
      if (ageMs < this.stalenessMs) continue;

      // Never reap a device currently associated with an active call (13.7).
      if (activeCallDeviceIds.has(device.deviceId)) continue;

      const deactivated = await this.registry.deactivateDevice(device.deviceId);
      if (deactivated) {
        reaped.push(device.deviceId);
      }
    }

    return reaped;
  }
}
