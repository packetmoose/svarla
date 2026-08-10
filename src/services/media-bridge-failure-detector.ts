/**
 * MediaBridgeFailureDetector — Detects MediaBridge crashes or unresponsiveness
 * and transitions all active calls to ENDED with reason FAILED.
 *
 * Detection mechanisms:
 * 1. Health check polling failure (MediaBridgeClient.isCurrentlyHealthy transitions true → false)
 * 2. Event WebSocket disconnect (MediaBridgeEventListener.isConnected() transitions to false)
 *
 * On failure detection:
 * - Ends all active calls via CallOrchestrator.endAllCalls()
 * - Notifies all clients via WebSocket call_event {status: failed}
 * - Logs structured warning for operational monitoring
 *
 * Safety: Does NOT trigger on initial startup when MediaBridge hasn't connected yet.
 * Only triggers when MediaBridge was previously healthy/connected and then becomes unhealthy/disconnected.
 *
 * Requirements: 4.10, 2.8
 */

import type { MediaBridgeClient } from './media-bridge-client.js';
import type { MediaBridgeEventListener } from './media-bridge-event-listener.js';
import type { CallOrchestrator } from './call-orchestrator.js';
import type { WebSocketBroadcaster } from '../websocket/broadcaster.js';

/**
 * Logger interface compatible with Fastify/Pino.
 */
export interface FailureDetectorLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Configuration for the failure detector.
 */
export interface MediaBridgeFailureDetectorConfig {
  /** Polling interval in ms for checking health/connection status. Default: 2000 */
  pollInterval?: number;
  /** Logger instance */
  logger: FailureDetectorLogger;
}

/**
 * Dependencies injected into MediaBridgeFailureDetector.
 */
export interface MediaBridgeFailureDetectorDeps {
  mediaBridgeClient: MediaBridgeClient;
  mediaBridgeEventListener: MediaBridgeEventListener;
  callOrchestrator: CallOrchestrator;
  wsBroadcaster: WebSocketBroadcaster;
}

export class MediaBridgeFailureDetector {
  private readonly mediaBridgeClient: MediaBridgeClient;
  private readonly mediaBridgeEventListener: MediaBridgeEventListener;
  private readonly callOrchestrator: CallOrchestrator;
  private readonly wsBroadcaster: WebSocketBroadcaster;
  private readonly logger: FailureDetectorLogger;
  private readonly pollInterval: number;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Tracks whether health was previously observed as healthy (prevents false trigger on startup) */
  private wasHealthy = false;
  /** Tracks whether the event WebSocket was previously connected (prevents false trigger on startup) */
  private wasConnected = false;
  /** Prevents multiple concurrent failure handlings */
  private handlingFailure = false;

  constructor(
    deps: MediaBridgeFailureDetectorDeps,
    config: MediaBridgeFailureDetectorConfig,
  ) {
    this.mediaBridgeClient = deps.mediaBridgeClient;
    this.mediaBridgeEventListener = deps.mediaBridgeEventListener;
    this.callOrchestrator = deps.callOrchestrator;
    this.wsBroadcaster = deps.wsBroadcaster;
    this.logger = config.logger;
    this.pollInterval = config.pollInterval ?? 2000;
  }

  /**
   * Start monitoring for MediaBridge failures.
   * Call this after all services have been initialized.
   */
  start(): void {
    if (this.pollTimer !== null) {
      return; // Already running
    }

    this.pollTimer = setInterval(() => {
      this.check();
    }, this.pollInterval);

    this.logger.info('MediaBridge failure detector started');
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Perform a single health/connection check cycle.
   * Exposed for testing.
   */
  check(): void {
    const isHealthy = this.mediaBridgeClient.isCurrentlyHealthy;
    const isConnected = this.mediaBridgeEventListener.isConnected();

    // Track transitions: if the bridge becomes healthy/connected, record it
    if (isHealthy) {
      this.wasHealthy = true;
    }
    if (isConnected) {
      this.wasConnected = true;
    }

    // Detect failure: was healthy/connected before but no longer
    const healthFailure = this.wasHealthy && !isHealthy;
    const connectionFailure = this.wasConnected && !isConnected;

    if ((healthFailure || connectionFailure) && !this.handlingFailure) {
      const reason = healthFailure
        ? 'health_check_failure'
        : 'event_websocket_disconnect';

      this.handleFailure(reason);
    }
  }

  /**
   * Handle a detected MediaBridge failure.
   */
  private handleFailure(reason: string): void {
    this.handlingFailure = true;

    // Reset state so we can detect the next failure after recovery
    this.wasHealthy = false;
    this.wasConnected = false;

    // 1. Log structured warning for operational monitoring
    this.logger.warn(
      { reason, component: 'MediaBridge', event: 'failure_detected' },
      'MediaBridge failure detected — ending all active calls',
    );

    // 2. Broadcast failure event to all connected clients
    this.wsBroadcaster.broadcast({
      type: 'call_event',
      data: {
        status: 'failed',
        reason: 'media_service_unavailable',
      },
    });

    // 3. End all active calls via the orchestrator
    this.callOrchestrator
      .endAllCalls('MediaBridge failure')
      .catch((err) => {
        this.logger.error(
          { err } as Record<string, unknown>,
          'Error while ending calls after MediaBridge failure',
        );
      })
      .finally(() => {
        this.handlingFailure = false;
      });
  }
}
