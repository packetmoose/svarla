/**
 * Wake-up signal sent through UnifiedPush.
 * Contains ONLY an ID and a priority level — no notification type metadata.
 * The app fetches actual content (including type) from the server after waking.
 *
 * Priority levels:
 * - "high": requires immediate handling (e.g., incoming call that needs Telecom routing)
 * - "normal": can be fetched and displayed asynchronously
 *
 * This avoids leaking metadata (call made, message received, etc.) through the push channel.
 */
export interface WakeSignal {
  id: string;
  priority: 'high' | 'normal';
}

/**
 * Device push delivery info.
 */
export interface DevicePushInfo {
  deviceId: string;
  pushEndpointUrl: string | null;
}

/**
 * Result of a publish operation to a single device.
 */
export interface PublishResult {
  deviceId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Sends minimal wake signals to devices via their registered UnifiedPush endpoint URLs.
 *
 * The server has no knowledge of ntfy or any specific push provider.
 * It simply POSTs a small JSON body to whatever URL the client registered.
 * The UnifiedPush distributor on the device (e.g., ntfy app) handles delivery.
 *
 * Devices without a registered endpoint URL are skipped — they must register
 * via PUT /api/devices/:deviceId/push-endpoint after obtaining an endpoint
 * from their UnifiedPush distributor.
 */
export class WakeSignalPublisher {
  constructor() {}

  /**
   * Send a wake signal to a single device.
   * Skips devices without a registered push endpoint URL.
   */
  async sendWakeSignal(device: DevicePushInfo, signal: WakeSignal): Promise<PublishResult> {
    if (!device.pushEndpointUrl) {
      return {
        deviceId: device.deviceId,
        success: false,
        error: 'No push endpoint URL registered',
      };
    }

    const body = JSON.stringify(signal);

    try {
      const response = await fetch(device.pushEndpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body,
      });

      return {
        deviceId: device.deviceId,
        success: response.ok,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        deviceId: device.deviceId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Send wake signals to all devices in parallel.
   * Devices without a registered endpoint URL are skipped.
   */
  async sendToAllDevices(devices: DevicePushInfo[], signal: WakeSignal): Promise<PublishResult[]> {
    if (devices.length === 0) {
      return [];
    }

    // Only attempt delivery to devices that have a registered push endpoint
    const results = await Promise.allSettled(
      devices.map((device) => this.sendWakeSignal(device, signal))
    );

    return results.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        deviceId: devices[idx].deviceId,
        success: false,
        error: result.reason instanceof Error ? result.reason.message : 'Unknown error',
      };
    });
  }
}
