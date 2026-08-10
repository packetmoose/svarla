import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocketBroadcaster, type WebSocketEvent } from './broadcaster.js';
import type { AuthService } from '../services/auth-service.js';
import type { WebSocket } from 'ws';

/**
 * Create a mock WebSocket with controllable readyState.
 */
function createMockSocket(readyState: number = 1): WebSocket {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const socket = {
    readyState,
    OPEN: 1,
    CLOSED: 3,
    send: vi.fn(),
    close: vi.fn(),
    ping: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) {
        listeners[event] = [];
      }
      listeners[event].push(handler);
    }),
    // Utility for tests to trigger events
    _trigger: (event: string, ...args: unknown[]) => {
      for (const handler of listeners[event] ?? []) {
        handler(...args);
      }
    },
  } as unknown as WebSocket & { _trigger: (event: string, ...args: unknown[]) => void };
  return socket;
}

/**
 * Create a mock AuthService.
 */
function createMockAuthService(validSessions: Map<string, { deviceId: string; deviceName: string }>): AuthService {
  return {
    validateSession: vi.fn(async (token: string) => {
      const session = validSessions.get(token);
      if (session) {
        return { valid: true, deviceId: session.deviceId, deviceName: session.deviceName };
      }
      return { valid: false };
    }),
  } as unknown as AuthService;
}

/**
 * Helper to set up connections in the broadcaster's internal map.
 * Adapts to the Set-based connection store.
 */
function setConnection(broadcaster: WebSocketBroadcaster, deviceId: string, socket: WebSocket): void {
  const connections = (broadcaster as unknown as { connections: Map<string, Set<WebSocket>> }).connections;
  let sockets = connections.get(deviceId);
  if (!sockets) {
    sockets = new Set();
    connections.set(deviceId, sockets);
  }
  sockets.add(socket);
}

describe('WebSocketBroadcaster', () => {
  let broadcaster: WebSocketBroadcaster;
  let authService: AuthService;
  const validSessions = new Map<string, { deviceId: string; deviceName: string }>();

  beforeEach(() => {
    validSessions.clear();
    validSessions.set('token-device-1', { deviceId: 'device-1', deviceName: 'Phone 1' });
    validSessions.set('token-device-2', { deviceId: 'device-2', deviceName: 'Phone 2' });
    validSessions.set('token-device-3', { deviceId: 'device-3', deviceName: 'Tablet' });

    authService = createMockAuthService(validSessions);
    broadcaster = new WebSocketBroadcaster(authService);
  });

  describe('connection management', () => {
    it('should start with zero connections', () => {
      expect(broadcaster.getConnectionCount()).toBe(0);
      expect(broadcaster.getConnectedDeviceIds()).toEqual([]);
    });

    it('should report device as not connected when not registered', () => {
      expect(broadcaster.isDeviceConnected('device-1')).toBe(false);
    });
  });

  describe('broadcast', () => {
    it('should send event to all connected devices', () => {
      const socket1 = createMockSocket(1);
      const socket2 = createMockSocket(1);
      const socket3 = createMockSocket(1);

      setConnection(broadcaster, 'device-1', socket1);
      setConnection(broadcaster, 'device-2', socket2);
      setConnection(broadcaster, 'device-3', socket3);

      const event: WebSocketEvent = {
        type: 'new_message',
        data: { conversationNumber: '+1234567890', message: { id: 'msg-1' } },
      };

      broadcaster.broadcast(event);

      const expectedMessage = JSON.stringify(event);
      expect(socket1.send).toHaveBeenCalledWith(expectedMessage);
      expect(socket2.send).toHaveBeenCalledWith(expectedMessage);
      expect(socket3.send).toHaveBeenCalledWith(expectedMessage);
    });

    it('should not send to closed sockets', () => {
      const openSocket = createMockSocket(1);
      const closedSocket = createMockSocket(3);

      setConnection(broadcaster, 'device-1', openSocket);
      setConnection(broadcaster, 'device-2', closedSocket);

      const event: WebSocketEvent = {
        type: 'call_event',
        data: { callId: 'call-1', status: 'ringing' },
      };

      broadcaster.broadcast(event);

      expect(openSocket.send).toHaveBeenCalledWith(JSON.stringify(event));
      expect(closedSocket.send).not.toHaveBeenCalled();
    });

    it('should handle broadcast with no connections gracefully', () => {
      const event: WebSocketEvent = {
        type: 'device_registered',
        data: { deviceId: 'new-device', name: 'New Phone' },
      };

      // Should not throw
      expect(() => broadcaster.broadcast(event)).not.toThrow();
    });

    it('should send to multiple sockets for the same device', () => {
      const socket1 = createMockSocket(1);
      const socket2 = createMockSocket(1);

      setConnection(broadcaster, 'device-1', socket1);
      setConnection(broadcaster, 'device-1', socket2);

      const event: WebSocketEvent = {
        type: 'new_message',
        data: { conversationNumber: '+1234567890' },
      };

      broadcaster.broadcast(event);

      const expectedMessage = JSON.stringify(event);
      expect(socket1.send).toHaveBeenCalledWith(expectedMessage);
      expect(socket2.send).toHaveBeenCalledWith(expectedMessage);
    });
  });

  describe('broadcastToDevice', () => {
    it('should send event only to the specified device', () => {
      const socket1 = createMockSocket(1);
      const socket2 = createMockSocket(1);

      setConnection(broadcaster, 'device-1', socket1);
      setConnection(broadcaster, 'device-2', socket2);

      const event: WebSocketEvent = {
        type: 'message_status',
        data: { messageId: 'msg-1', status: 'SENT' },
      };

      broadcaster.broadcastToDevice('device-1', event);

      expect(socket1.send).toHaveBeenCalledWith(JSON.stringify(event));
      expect(socket2.send).not.toHaveBeenCalled();
    });

    it('should send to all sockets for the targeted device', () => {
      const socket1 = createMockSocket(1);
      const socket2 = createMockSocket(1);

      setConnection(broadcaster, 'device-1', socket1);
      setConnection(broadcaster, 'device-1', socket2);

      const event: WebSocketEvent = {
        type: 'message_status',
        data: { messageId: 'msg-1', status: 'SENT' },
      };

      broadcaster.broadcastToDevice('device-1', event);

      const expectedMessage = JSON.stringify(event);
      expect(socket1.send).toHaveBeenCalledWith(expectedMessage);
      expect(socket2.send).toHaveBeenCalledWith(expectedMessage);
    });

    it('should not throw when device is not connected', () => {
      const event: WebSocketEvent = {
        type: 'message_status',
        data: { messageId: 'msg-1', status: 'SENT' },
      };

      expect(() => broadcaster.broadcastToDevice('nonexistent-device', event)).not.toThrow();
    });

    it('should not send to a closed socket', () => {
      const closedSocket = createMockSocket(3);

      setConnection(broadcaster, 'device-1', closedSocket);

      const event: WebSocketEvent = {
        type: 'call_cancelled',
        data: { callId: 'call-1', reason: 'answered_elsewhere' },
      };

      broadcaster.broadcastToDevice('device-1', event);

      expect(closedSocket.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastExcept', () => {
    it('should send event to all devices except the excluded one', () => {
      const socket1 = createMockSocket(1);
      const socket2 = createMockSocket(1);
      const socket3 = createMockSocket(1);

      setConnection(broadcaster, 'device-1', socket1);
      setConnection(broadcaster, 'device-2', socket2);
      setConnection(broadcaster, 'device-3', socket3);

      const event: WebSocketEvent = {
        type: 'call_history_update',
        data: { entry: { id: 'entry-1' } },
      };

      broadcaster.broadcastExcept('device-2', event);

      const expectedMessage = JSON.stringify(event);
      expect(socket1.send).toHaveBeenCalledWith(expectedMessage);
      expect(socket2.send).not.toHaveBeenCalled();
      expect(socket3.send).toHaveBeenCalledWith(expectedMessage);
    });

    it('should send to all if excluded device is not connected', () => {
      const socket1 = createMockSocket(1);
      const socket2 = createMockSocket(1);

      setConnection(broadcaster, 'device-1', socket1);
      setConnection(broadcaster, 'device-2', socket2);

      const event: WebSocketEvent = {
        type: 'numbers_changed',
        data: { numbers: [], added: ['+1555000111'], removed: [] },
      };

      broadcaster.broadcastExcept('nonexistent-device', event);

      const expectedMessage = JSON.stringify(event);
      expect(socket1.send).toHaveBeenCalledWith(expectedMessage);
      expect(socket2.send).toHaveBeenCalledWith(expectedMessage);
    });

    it('should not send to closed sockets even when not excluded', () => {
      const openSocket = createMockSocket(1);
      const closedSocket = createMockSocket(3);

      setConnection(broadcaster, 'device-1', openSocket);
      setConnection(broadcaster, 'device-2', closedSocket);

      const event: WebSocketEvent = {
        type: 'number_label_updated',
        data: { number: '+1555000111', label: 'Work' },
      };

      broadcaster.broadcastExcept('device-3', event);

      expect(openSocket.send).toHaveBeenCalledWith(JSON.stringify(event));
      expect(closedSocket.send).not.toHaveBeenCalled();
    });
  });

  describe('connection tracking', () => {
    it('should report correct connection count (number of devices)', () => {
      setConnection(broadcaster, 'device-1', createMockSocket(1));
      setConnection(broadcaster, 'device-2', createMockSocket(1));

      expect(broadcaster.getConnectionCount()).toBe(2);
    });

    it('should count device once even with multiple sockets', () => {
      setConnection(broadcaster, 'device-1', createMockSocket(1));
      setConnection(broadcaster, 'device-1', createMockSocket(1));

      expect(broadcaster.getConnectionCount()).toBe(1);
    });

    it('should report connected device IDs', () => {
      setConnection(broadcaster, 'device-1', createMockSocket(1));
      setConnection(broadcaster, 'device-3', createMockSocket(1));

      expect(broadcaster.getConnectedDeviceIds().sort()).toEqual(['device-1', 'device-3']);
    });

    it('should report device as connected when socket is open', () => {
      setConnection(broadcaster, 'device-1', createMockSocket(1));

      expect(broadcaster.isDeviceConnected('device-1')).toBe(true);
    });

    it('should report device as not connected when all sockets are closed', () => {
      setConnection(broadcaster, 'device-1', createMockSocket(3)); // CLOSED state

      expect(broadcaster.isDeviceConnected('device-1')).toBe(false);
    });
  });

  describe('closeAll', () => {
    it('should close all connections and clear the map', () => {
      const socket1 = createMockSocket(1);
      const socket2 = createMockSocket(1);

      setConnection(broadcaster, 'device-1', socket1);
      setConnection(broadcaster, 'device-2', socket2);

      broadcaster.closeAll();

      expect(socket1.close).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect(socket2.close).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect(broadcaster.getConnectionCount()).toBe(0);
    });

    it('should close all sockets for a device with multiple tabs', () => {
      const socket1 = createMockSocket(1);
      const socket2 = createMockSocket(1);

      setConnection(broadcaster, 'device-1', socket1);
      setConnection(broadcaster, 'device-1', socket2);

      broadcaster.closeAll();

      expect(socket1.close).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect(socket2.close).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect(broadcaster.getConnectionCount()).toBe(0);
    });
  });

  describe('authenticateAndRegister', () => {
    it('should close socket with 1008 when token is invalid', async () => {
      const socket = createMockSocket(1);

      const authenticateAndRegister = (broadcaster as unknown as {
        authenticateAndRegister: (socket: WebSocket, token: string) => Promise<void>;
      }).authenticateAndRegister.bind(broadcaster);

      await authenticateAndRegister(socket, 'invalid-token');

      expect(socket.close).toHaveBeenCalledWith(1008, 'Invalid or expired session');
    });

    it('should register connection when token is valid', async () => {
      const socket = createMockSocket(1);

      const authenticateAndRegister = (broadcaster as unknown as {
        authenticateAndRegister: (socket: WebSocket, token: string) => Promise<void>;
      }).authenticateAndRegister.bind(broadcaster);

      await authenticateAndRegister(socket, 'token-device-1');

      expect(broadcaster.isDeviceConnected('device-1')).toBe(true);
      expect(broadcaster.getConnectionCount()).toBe(1);
    });

    it('should allow multiple connections for the same device', async () => {
      const socket1 = createMockSocket(1);
      const socket2 = createMockSocket(1);

      const authenticateAndRegister = (broadcaster as unknown as {
        authenticateAndRegister: (socket: WebSocket, token: string) => Promise<void>;
      }).authenticateAndRegister.bind(broadcaster);

      await authenticateAndRegister(socket1, 'token-device-1');
      await authenticateAndRegister(socket2, 'token-device-1');

      // Both should be active, not replaced
      expect(socket1.close).not.toHaveBeenCalled();
      expect(broadcaster.getConnectionCount()).toBe(1); // Still 1 device

      // Both should receive broadcasts
      const event: WebSocketEvent = {
        type: 'new_message',
        data: { test: true },
      };
      broadcaster.broadcast(event);
      expect(socket1.send).toHaveBeenCalled();
      expect(socket2.send).toHaveBeenCalled();
    });

    it('should remove connection on socket close event', async () => {
      const socket = createMockSocket(1) as WebSocket & { _trigger: (event: string, ...args: unknown[]) => void };

      const authenticateAndRegister = (broadcaster as unknown as {
        authenticateAndRegister: (socket: WebSocket, token: string) => Promise<void>;
      }).authenticateAndRegister.bind(broadcaster);

      await authenticateAndRegister(socket, 'token-device-1');
      expect(broadcaster.isDeviceConnected('device-1')).toBe(true);

      // Trigger the close event
      socket._trigger('close');
      expect(broadcaster.getConnectionCount()).toBe(0);
    });

    it('should only remove the closed socket when device has multiple connections', async () => {
      const socket1 = createMockSocket(1) as WebSocket & { _trigger: (event: string, ...args: unknown[]) => void };
      const socket2 = createMockSocket(1) as WebSocket & { _trigger: (event: string, ...args: unknown[]) => void };

      const authenticateAndRegister = (broadcaster as unknown as {
        authenticateAndRegister: (socket: WebSocket, token: string) => Promise<void>;
      }).authenticateAndRegister.bind(broadcaster);

      await authenticateAndRegister(socket1, 'token-device-1');
      await authenticateAndRegister(socket2, 'token-device-1');

      // Close first socket
      socket1._trigger('close');

      // Device should still be connected via socket2
      expect(broadcaster.isDeviceConnected('device-1')).toBe(true);
      expect(broadcaster.getConnectionCount()).toBe(1);
    });

    it('should remove connection on socket error event', async () => {
      const socket = createMockSocket(1) as WebSocket & { _trigger: (event: string, ...args: unknown[]) => void };

      const authenticateAndRegister = (broadcaster as unknown as {
        authenticateAndRegister: (socket: WebSocket, token: string) => Promise<void>;
      }).authenticateAndRegister.bind(broadcaster);

      await authenticateAndRegister(socket, 'token-device-2');
      expect(broadcaster.isDeviceConnected('device-2')).toBe(true);

      // Trigger the error event
      socket._trigger('error', new Error('Connection reset'));
      expect(broadcaster.getConnectionCount()).toBe(0);
    });

    it('should close socket with 1008 when auth service throws', async () => {
      const socket = createMockSocket(1);
      const throwingAuthService = {
        validateSession: vi.fn(async () => { throw new Error('DB error'); }),
      } as unknown as AuthService;

      const throwingBroadcaster = new WebSocketBroadcaster(throwingAuthService);
      const authenticateAndRegister = (throwingBroadcaster as unknown as {
        authenticateAndRegister: (socket: WebSocket, token: string) => Promise<void>;
      }).authenticateAndRegister.bind(throwingBroadcaster);

      await authenticateAndRegister(socket, 'any-token');

      expect(socket.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    });
  });

  describe('event format', () => {
    it('should send events as JSON with type and data fields', () => {
      const socket = createMockSocket(1);
      setConnection(broadcaster, 'device-1', socket);

      const event: WebSocketEvent = {
        type: 'device_deregistered',
        data: { deviceId: 'device-99' },
      };

      broadcaster.broadcast(event);

      const sentMessage = (socket.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const parsed = JSON.parse(sentMessage as string);
      expect(parsed).toEqual({
        type: 'device_deregistered',
        data: { deviceId: 'device-99' },
      });
    });
  });
});
