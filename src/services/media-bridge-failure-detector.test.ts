import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MediaBridgeFailureDetector,
  type MediaBridgeFailureDetectorDeps,
  type MediaBridgeFailureDetectorConfig,
} from './media-bridge-failure-detector.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

function createMockDeps(): MediaBridgeFailureDetectorDeps {
  return {
    mediaBridgeClient: {
      get isCurrentlyHealthy() { return false; },
      startHealthChecks: vi.fn(),
      stopHealthChecks: vi.fn(),
    } as any,
    mediaBridgeEventListener: {
      isConnected: vi.fn().mockReturnValue(false),
    } as any,
    callOrchestrator: {
      endAllCalls: vi.fn().mockResolvedValue(undefined),
    } as any,
    wsBroadcaster: {
      broadcast: vi.fn(),
    } as any,
  };
}

function createConfig(): MediaBridgeFailureDetectorConfig {
  return {
    pollInterval: 1000,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MediaBridgeFailureDetector', () => {
  let deps: MediaBridgeFailureDetectorDeps;
  let config: MediaBridgeFailureDetectorConfig;
  let detector: MediaBridgeFailureDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = createMockDeps();
    config = createConfig();
  });

  afterEach(() => {
    detector?.stop();
    vi.useRealTimers();
  });

  describe('startup safety', () => {
    it('does NOT trigger failure on initial startup when MediaBridge is not yet running', () => {
      // MediaBridge not healthy and not connected from the start
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => false });
      (deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      detector = new MediaBridgeFailureDetector(deps, config);
      detector.start();

      // Advance several poll intervals
      vi.advanceTimersByTime(5000);

      // Should NOT have triggered failure handling
      expect(deps.callOrchestrator.endAllCalls).not.toHaveBeenCalled();
      expect(deps.wsBroadcaster.broadcast).not.toHaveBeenCalled();
    });

    it('does NOT trigger failure if bridge was never healthy', () => {
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => false });
      (deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      detector = new MediaBridgeFailureDetector(deps, config);
      detector.check();
      detector.check();
      detector.check();

      expect(deps.callOrchestrator.endAllCalls).not.toHaveBeenCalled();
    });
  });

  describe('health check failure detection', () => {
    it('triggers failure when health transitions from healthy to unhealthy', () => {
      let healthy = true;
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => healthy });
      (deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      detector = new MediaBridgeFailureDetector(deps, config);

      // First check: bridge is healthy → records "wasHealthy"
      detector.check();
      expect(deps.callOrchestrator.endAllCalls).not.toHaveBeenCalled();

      // Second check: bridge becomes unhealthy → triggers failure
      healthy = false;
      detector.check();

      expect(deps.callOrchestrator.endAllCalls).toHaveBeenCalledWith('MediaBridge failure');
      expect(deps.wsBroadcaster.broadcast).toHaveBeenCalledWith({
        type: 'call_event',
        data: {
          status: 'failed',
          reason: 'media_service_unavailable',
        },
      });
    });

    it('logs structured warning on failure detection', () => {
      let healthy = true;
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => healthy });
      (deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      detector = new MediaBridgeFailureDetector(deps, config);
      detector.check();

      healthy = false;
      detector.check();

      expect(config.logger.warn).toHaveBeenCalledWith(
        { reason: 'health_check_failure', component: 'MediaBridge', event: 'failure_detected' },
        'MediaBridge failure detected — ending all active calls',
      );
    });
  });

  describe('WebSocket disconnect failure detection', () => {
    it('triggers failure when event WebSocket disconnects after being connected', () => {
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => false });
      const isConnectedMock = deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>;
      isConnectedMock.mockReturnValue(true);

      detector = new MediaBridgeFailureDetector(deps, config);

      // First check: WebSocket connected → records "wasConnected"
      detector.check();
      expect(deps.callOrchestrator.endAllCalls).not.toHaveBeenCalled();

      // Second check: WebSocket disconnects → triggers failure
      isConnectedMock.mockReturnValue(false);
      detector.check();

      expect(deps.callOrchestrator.endAllCalls).toHaveBeenCalledWith('MediaBridge failure');
      expect(config.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'event_websocket_disconnect' }),
        expect.any(String),
      );
    });
  });

  describe('recovery and re-detection', () => {
    it('can detect a second failure after recovery', async () => {
      let healthy = true;
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => healthy });
      (deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      detector = new MediaBridgeFailureDetector(deps, config);

      // Healthy → detected
      detector.check();
      healthy = false;
      detector.check();

      expect(deps.callOrchestrator.endAllCalls).toHaveBeenCalledTimes(1);

      // Let endAllCalls promise resolve so handlingFailure flag resets
      await vi.runAllTimersAsync();

      // Recovery: bridge becomes healthy again
      healthy = true;
      detector.check();

      // Then fails again
      healthy = false;
      detector.check();

      expect(deps.callOrchestrator.endAllCalls).toHaveBeenCalledTimes(2);
    });

    it('does not trigger multiple times for the same failure', () => {
      let healthy = true;
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => healthy });
      (deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      detector = new MediaBridgeFailureDetector(deps, config);
      detector.check(); // healthy

      healthy = false;
      detector.check(); // first failure detection
      detector.check(); // should not trigger again (wasHealthy reset)
      detector.check(); // should not trigger again

      expect(deps.callOrchestrator.endAllCalls).toHaveBeenCalledTimes(1);
    });
  });

  describe('polling lifecycle', () => {
    it('polls on the configured interval when started', () => {
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => true });
      (deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      detector = new MediaBridgeFailureDetector(deps, config);
      detector.start();

      // The isConnected method is called once per poll cycle
      expect(deps.mediaBridgeEventListener.isConnected).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(deps.mediaBridgeEventListener.isConnected).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      expect(deps.mediaBridgeEventListener.isConnected).toHaveBeenCalledTimes(2);
    });

    it('stops polling when stop() is called', () => {
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => true });
      (deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      detector = new MediaBridgeFailureDetector(deps, config);
      detector.start();

      vi.advanceTimersByTime(1000);
      expect(deps.mediaBridgeEventListener.isConnected).toHaveBeenCalledTimes(1);

      detector.stop();

      vi.advanceTimersByTime(5000);
      // No additional calls after stop
      expect(deps.mediaBridgeEventListener.isConnected).toHaveBeenCalledTimes(1);
    });

    it('does not start twice', () => {
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => true });
      (deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      detector = new MediaBridgeFailureDetector(deps, config);
      detector.start();
      detector.start(); // second start should be no-op

      vi.advanceTimersByTime(1000);
      // Only 1 call, not 2 (which would happen with two intervals)
      expect(deps.mediaBridgeEventListener.isConnected).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('logs error if endAllCalls throws', async () => {
      let healthy = true;
      Object.defineProperty(deps.mediaBridgeClient, 'isCurrentlyHealthy', { get: () => healthy });
      (deps.mediaBridgeEventListener.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (deps.callOrchestrator.endAllCalls as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));

      detector = new MediaBridgeFailureDetector(deps, config);
      detector.check(); // healthy

      healthy = false;
      detector.check(); // trigger failure

      // Let the promise reject and be caught
      await vi.runAllTimersAsync();

      expect(config.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Error while ending calls after MediaBridge failure',
      );
    });
  });
});
