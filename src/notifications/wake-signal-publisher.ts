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
 * Minimal logger interface compatible with Fastify/Pino.
 * Optional — the publisher works without a logger, but when provided it surfaces
 * per-device delivery results (including HTTP status) so stale/expired push
 * endpoints returning 4xx/5xx are visible in server logs.
 */
export interface WakeSignalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
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
  private readonly logger?: WakeSignalLogger;

  constructor(logger?: WakeSignalLogger) {
    this.logger = logger;
  }

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
  async sendToAllDevices(
    devices: DevicePushInfo[],
    signal: WakeSignal,
    context?: string
  ): Promise<PublishResult[]> {
    if (devices.length === 0) {
      return [];
    }

    // Only attempt delivery to devices that have a registered push endpoint
    const settled = await Promise.allSettled(
      devices.map((device) => this.sendWakeSignal(device, signal))
    );

    const results = settled.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        deviceId: devices[idx].deviceId,
        success: false,
        error: result.reason instanceof Error ? result.reason.message : 'Unknown error',
      };
    });

    this.logResults(results, signal, context);

    return results;
  }

  /**
   * Logs an aggregate summary plus a per-device warning for each failed
   * delivery (with HTTP status when available). No-op when no logger was
   * provided. Never throws — logging must not break delivery.
   */
  private logResults(results: PublishResult[], signal: WakeSignal, context?: string): void {
    if (!this.logger) {
      return;
    }

    try {
      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success);

      this.logger.info(
        {
          context: context ?? 'wake_signal',
          signalId: signal.id,
          priority: signal.priority,
          targetDeviceCount: results.length,
          succeeded,
          failedCount: failed.length,
        },
        'Wake signal delivery summary'
      );

      for (const result of failed) {
        this.logger.warn(
          {
            context: context ?? 'wake_signal',
            signalId: signal.id,
            deviceId: result.deviceId,
            statusCode: result.statusCode,
            error: result.error,
          },
          'Wake signal delivery to device failed'
        );
      }
    } catch {
      // Logging must never interfere with delivery.
    }
  }
}
