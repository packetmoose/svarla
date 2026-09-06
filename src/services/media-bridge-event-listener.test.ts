import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { MediaBridgeEventListener, type MediaBridgeSessionEvent, type MediaBridgeEventListenerConfig } from './media-bridge-event-listener.js';

/** Utility to wait for a condition or timeout */
function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

/** Utility to wait a fixed number of ms */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a silent logger for tests */
function createSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Get a random port to avoid conflicts between test runs */
function getTestPort(): number {
  return 19000 + Math.floor(Math.random() * 1000);
}

/**
 * Create a mock MediaBridge WebSocket server that the listener connects to.
 * Returns the server and its URL, plus a handle to the connected client.
 */
function createMockMediaBridge(port: number): {
  server: WebSocketServer;
  url: string;
  getClient: () => WsWebSocket | null;
  close: () => Promise<void>;
} {
  const wss = new WebSocketServer({ port, path: '/events' });
  let connectedClient: WsWebSocket | null = null;

  wss.on('connection', (ws) => {
    connectedClient = ws;
  });

  return {
    server: wss,
    url: `ws://127.0.0.1:${port}/events`,
    getClient: () => connectedClient,
    close: () => new Promise((resolve) => {
      wss.close(() => resolve());
    }),
  };
}

describe('MediaBridgeEventListener', () => {
  let listener: MediaBridgeEventListener;
  let port: number;
  let logger: ReturnType<typeof createSilentLogger>;
  let mockBridge: ReturnType<typeof createMockMediaBridge>;

  beforeEach(() => {
    port = getTestPort();
    logger = createSilentLogger();
  });

  afterEach(async () => {
    if (listener) {
      await listener.stop();
    }
    if (mockBridge) {
      await mockBridge.close();
    }
  });

  function createListener(overrides?: Partial<MediaBridgeEventListenerConfig>): MediaBridgeEventListener {
    return new MediaBridgeEventListener({
      url: mockBridge.url,
      reconnectInterval: 100, // Fast reconnect for tests
      logger,
      ...overrides,
    });
  }

  describe('start/stop', () => {
    it('should connect to the MediaBridge WebSocket endpoint', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      await listener.start();

      await waitFor(() => listener.isConnected());
      expect(listener.isConnected()).toBe(true);
      expect(listener.getHealthStatus().connected).toBe(true);
    });

    it('should stop cleanly and disconnect', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      await listener.start();

      await waitFor(() => listener.isConnected());
      await listener.stop();

      expect(listener.isConnected()).toBe(false);
    });
  });

  describe('reconnection', () => {
    it('should reconnect when the MediaBridge disconnects', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      await listener.start();

      await waitFor(() => listener.isConnected());

      // Close the server-side connection to simulate MediaBridge restart
      const client = mockBridge.getClient();
      client?.close();

      await waitFor(() => !listener.isConnected());
      expect(listener.isConnected()).toBe(false);

      // Should reconnect automatically
      await waitFor(() => listener.isConnected(), 3000);
      expect(listener.isConnected()).toBe(true);
    });

    it('should reconnect when MediaBridge is not available initially', async () => {
      // Don't start mock bridge yet — listener should retry
      mockBridge = createMockMediaBridge(port + 1); // Use wrong port initially
      listener = new MediaBridgeEventListener({
        url: `ws://127.0.0.1:${port}/events`, // Points to port with nothing running
        reconnectInterval: 100,
        logger,
      });
      await listener.start();

      await delay(200);
      expect(listener.isConnected()).toBe(false);

      // Now start the real mock bridge on the correct port
      await mockBridge.close();
      mockBridge = createMockMediaBridge(port);

      // Should reconnect
      await waitFor(() => listener.isConnected(), 3000);
      expect(listener.isConnected()).toBe(true);
    });

    it('should invoke the reconnect handler on a genuine reconnect but not the first connect', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();

      let reconnectCount = 0;
      listener.onReconnect(() => {
        reconnectCount += 1;
      });

      await listener.start();
      await waitFor(() => listener.isConnected());

      // First connect must NOT trigger the reconnect handler.
      expect(reconnectCount).toBe(0);

      // Simulate a drop; the server stays up so the listener reconnects.
      mockBridge.getClient()?.close();
      await waitFor(() => !listener.isConnected());
      await waitFor(() => listener.isConnected(), 3000);

      // The reconnect must have fired exactly once.
      await waitFor(() => reconnectCount === 1, 2000);
      expect(reconnectCount).toBe(1);
    });
  });

  describe('session event dispatching', () => {
    it('should dispatch client_connected events to the handler', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      const events: MediaBridgeSessionEvent[] = [];
      listener.onSessionEvent((event) => events.push(event));
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send(JSON.stringify({
        type: 'session_event',
        sessionId: 'session-123',
        event: 'client_connected',
      }));

      await waitFor(() => events.length > 0);
      expect(events[0]).toEqual({
        type: 'session_event',
        sessionId: 'session-123',
        event: 'client_connected',
      });
    });

    it('should dispatch provider_connected events', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      const events: MediaBridgeSessionEvent[] = [];
      listener.onSessionEvent((event) => events.push(event));
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send(JSON.stringify({
        type: 'session_event',
        sessionId: 'session-456',
        event: 'provider_connected',
      }));

      await waitFor(() => events.length > 0);
      expect(events[0]).toEqual({
        type: 'session_event',
        sessionId: 'session-456',
        event: 'provider_connected',
      });
    });

    it('should include reason for disconnect events', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      const events: MediaBridgeSessionEvent[] = [];
      listener.onSessionEvent((event) => events.push(event));
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send(JSON.stringify({
        type: 'session_event',
        sessionId: 'session-789',
        event: 'client_disconnected',
        reason: 'ice_failed',
      }));

      await waitFor(() => events.length > 0);
      expect(events[0]).toEqual({
        type: 'session_event',
        sessionId: 'session-789',
        event: 'client_disconnected',
        reason: 'ice_failed',
      });
    });

    it('should include digit for dtmf events', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      const events: MediaBridgeSessionEvent[] = [];
      listener.onSessionEvent((event) => events.push(event));
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send(JSON.stringify({
        type: 'session_event',
        sessionId: 'session-dtmf',
        event: 'dtmf',
        digit: '5',
      }));

      await waitFor(() => events.length > 0);
      expect(events[0]).toEqual({
        type: 'session_event',
        sessionId: 'session-dtmf',
        event: 'dtmf',
        digit: '5',
      });
    });

    it('should handle multiple events in sequence', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      const events: MediaBridgeSessionEvent[] = [];
      listener.onSessionEvent((event) => events.push(event));
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send(JSON.stringify({
        type: 'session_event',
        sessionId: 'session-multi',
        event: 'client_connected',
      }));
      client.send(JSON.stringify({
        type: 'session_event',
        sessionId: 'session-multi',
        event: 'provider_connected',
      }));
      client.send(JSON.stringify({
        type: 'session_event',
        sessionId: 'session-multi',
        event: 'dtmf',
        digit: '1',
      }));

      await waitFor(() => events.length === 3);
      expect(events).toHaveLength(3);
      expect(events[0].event).toBe('client_connected');
      expect(events[1].event).toBe('provider_connected');
      expect(events[2].event).toBe('dtmf');
    });
  });

  describe('health events', () => {
    it('should update health status on health events', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send(JSON.stringify({
        type: 'health',
        activeSessions: 3,
        uptime: 7200,
      }));

      await waitFor(() => listener.getHealthStatus().lastHealthEvent !== null);

      const status = listener.getHealthStatus();
      expect(status.connected).toBe(true);
      expect(status.lastHealthEvent).toEqual({
        type: 'health',
        activeSessions: 3,
        uptime: 7200,
      });
      expect(status.lastHealthEventAt).toBeInstanceOf(Date);
    });

    it('should not dispatch health events to session handler', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      const events: MediaBridgeSessionEvent[] = [];
      listener.onSessionEvent((event) => events.push(event));
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send(JSON.stringify({
        type: 'health',
        activeSessions: 1,
        uptime: 100,
      }));

      await delay(50);
      expect(events).toHaveLength(0);
    });
  });

  describe('invalid message handling', () => {
    it('should ignore non-JSON messages', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      const events: MediaBridgeSessionEvent[] = [];
      listener.onSessionEvent((event) => events.push(event));
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send('not valid json {{{');
      await delay(50);

      expect(events).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should ignore session events with missing sessionId', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      const events: MediaBridgeSessionEvent[] = [];
      listener.onSessionEvent((event) => events.push(event));
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send(JSON.stringify({
        type: 'session_event',
        event: 'client_connected',
      }));

      await delay(50);
      expect(events).toHaveLength(0);
    });

    it('should ignore session events with invalid event type', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      const events: MediaBridgeSessionEvent[] = [];
      listener.onSessionEvent((event) => events.push(event));
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send(JSON.stringify({
        type: 'session_event',
        sessionId: 'session-x',
        event: 'unknown_event',
      }));

      await delay(50);
      expect(events).toHaveLength(0);
    });

    it('should ignore unknown message types', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      const events: MediaBridgeSessionEvent[] = [];
      listener.onSessionEvent((event) => events.push(event));
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      client.send(JSON.stringify({
        type: 'unknown_type',
        data: 'something',
      }));

      await delay(50);
      expect(events).toHaveLength(0);
    });
  });

  describe('error handling in event handler', () => {
    it('should catch errors thrown by the session event handler', async () => {
      mockBridge = createMockMediaBridge(port);
      listener = createListener();
      listener.onSessionEvent(() => {
        throw new Error('Handler exploded');
      });
      await listener.start();

      await waitFor(() => mockBridge.getClient() !== null);
      const client = mockBridge.getClient()!;

      // Should not crash the listener
      client.send(JSON.stringify({
        type: 'session_event',
        sessionId: 'session-err',
        event: 'client_connected',
      }));

      await delay(50);
      expect(logger.error).toHaveBeenCalled();
      // Listener should still be functional
      expect(listener.isConnected()).toBe(true);
    });
  });
});
