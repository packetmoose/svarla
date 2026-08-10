import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AuthService } from '../services/auth-service.js';
import type { WsTicketService } from '../services/ws-ticket-service.js';

/**
 * WebSocket event types that can be broadcast to connected devices.
 */
export type WebSocketEventType =
  | 'new_message'
  | 'message_status'
  | 'call_event'
  | 'call_cancelled'
  | 'blocked_call'
  | 'call_history_update'
  | 'device_registered'
  | 'device_deregistered'
  | 'new_device_login'
  | 'number_label_updated'
  | 'numbers_changed'
  | 'read_state_updated'
  | 'ice_candidate'
  | 'notification_created'
  | 'notification_updated';

/**
 * WebSocket event format sent to connected devices.
 */
export interface WebSocketEvent {
  type: WebSocketEventType;
  data: Record<string, unknown>;
}

/**
 * ICE candidate message received from a client via WebSocket.
 */
export interface IceCandidateMessage {
  type: 'ice_candidate';
  callId: string;
  candidate: {
    candidate: string;
    sdpMid: string;
    sdpMLineIndex: number;
  };
}

/**
 * Handler for incoming WebSocket messages from clients.
 */
export type IncomingMessageHandler = (deviceId: string, message: IceCandidateMessage) => void;

/**
 * WebSocketBroadcaster manages WebSocket connections per device.
 * - Authenticates devices on connect using session tokens
 * - Stores multiple connections per deviceId (supports multiple browser tabs)
 * - Provides broadcast methods: to all, to specific device, to all except one
 * - Handles incoming messages from clients (e.g., ice_candidate)
 * - Runs a periodic ping to detect and clean up stale connections
 */
export class WebSocketBroadcaster {
  private readonly connections: Map<string, Set<WebSocket>> = new Map();
  private readonly authService: AuthService;
  private readonly wsTicketService?: WsTicketService;
  private readonly aliveSet: WeakSet<WebSocket> = new WeakSet();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private incomingMessageHandler: IncomingMessageHandler | null = null;
  /** Maps socket → deviceId for reverse lookup when handling incoming messages */
  private readonly socketToDevice: WeakMap<WebSocket, string> = new WeakMap();

  /** How often to send pings (ms). */
  private static readonly PING_INTERVAL_MS = 30_000;

  constructor(authService: AuthService, wsTicketService?: WsTicketService) {
    this.authService = authService;
    this.wsTicketService = wsTicketService;
  }

  /**
   * Register a handler for incoming ICE candidate messages from clients.
   * The handler receives the deviceId and the parsed ice_candidate message.
   */
  onIceCandidate(handler: IncomingMessageHandler): void {
    this.incomingMessageHandler = handler;
  }

  /**
   * Register the WebSocket endpoint at `/ws` on the Fastify server.
   * On upgrade, validates the session token from:
   *   1. Authorization header (Bearer <token>)
   *   2. Query param ?token=<token>
   * If invalid, closes with 1008 (Policy Violation).
   * If valid, stores the connection keyed by deviceId.
   */
  async register(server: FastifyInstance): Promise<void> {
    const websocketPlugin = await import('@fastify/websocket');
    await server.register(websocketPlugin.default);

    server.get('/ws', { websocket: true }, (socket, request) => {
      // Extract token from Authorization header or query param
      const authHeader = request.headers.authorization;
      let token: string | undefined;
      let isTicket = false;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      } else {
        const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
        // Prefer ticket-based auth (short-lived, single-use)
        const ticket = url.searchParams.get('ticket') ?? undefined;
        if (ticket) {
          token = ticket;
          isTicket = true;
        } else {
          // Fallback to token param for backward compatibility
          token = url.searchParams.get('token') ?? undefined;
        }
      }

      if (!token) {
        socket.close(1008, 'Authentication required');
        return;
      }

      // Validate the session token or ticket asynchronously
      this.authenticateAndRegister(socket, token, isTicket);
    });

    // Start periodic ping to detect dead connections
    this.startPingInterval();
  }

  /**
   * Authenticate the WebSocket connection and register it if valid.
   * Supports both direct session tokens and short-lived tickets.
   */
  private async authenticateAndRegister(socket: WebSocket, token: string, isTicket = false): Promise<void> {
    try {
      let sessionToken: string;
      let deviceId: string | undefined;

      if (isTicket && this.wsTicketService) {
        // Ticket-based auth: consume the ticket and get the session info
        const ticketInfo = this.wsTicketService.consumeTicket(token);
        if (!ticketInfo) {
          console.log('[WS] Connection rejected: invalid or expired ticket');
          socket.close(1008, 'Invalid or expired ticket');
          return;
        }
        sessionToken = ticketInfo.sessionToken;
        deviceId = ticketInfo.deviceId;
      } else {
        // Direct session token auth
        sessionToken = token;
      }

      const session = await this.authService.validateSession(sessionToken);

      if (!session.valid || !session.deviceId) {
        console.log('[WS] Connection rejected: invalid session');
        socket.close(1008, 'Invalid or expired session');
        return;
      }

      deviceId = session.deviceId;
      console.log(`[WS] Device connected: ${deviceId}`);

      // Add this socket to the device's connection set
      let deviceSockets = this.connections.get(deviceId);
      if (!deviceSockets) {
        deviceSockets = new Set();
        this.connections.set(deviceId, deviceSockets);
      }
      deviceSockets.add(socket);

      // Mark as alive for ping/pong health checks
      this.aliveSet.add(socket);

      // Track socket → deviceId for incoming message routing
      this.socketToDevice.set(socket, deviceId);

      // Listen for pong responses
      socket.on('pong', () => {
        this.aliveSet.add(socket);
      });

      // Handle incoming messages from clients (e.g., ice_candidate)
      socket.on('message', (data) => {
        this.handleIncomingMessage(socket, data);
      });

      // Handle disconnect
      socket.on('close', (code, reason) => {
        console.log(`[WS] Device disconnected: ${deviceId} (code=${code}, reason=${reason})`);
        const sockets = this.connections.get(deviceId);
        if (sockets) {
          sockets.delete(socket);
          if (sockets.size === 0) {
            this.connections.delete(deviceId);
          }
        }
      });

      socket.on('error', (err) => {
        console.log(`[WS] Device error: ${deviceId}`, err);
        const sockets = this.connections.get(deviceId);
        if (sockets) {
          sockets.delete(socket);
          if (sockets.size === 0) {
            this.connections.delete(deviceId);
          }
        }
      });
    } catch {
      socket.close(1008, 'Authentication failed');
    }
  }

  /**
   * Broadcast an event to ALL connected devices (all sockets).
   */
  broadcast(event: WebSocketEvent): void {
    const message = JSON.stringify(event);
    let totalSockets = 0;
    for (const sockets of this.connections.values()) {
      totalSockets += sockets.size;
    }
    console.log(`[WS] Broadcasting ${event.type} to ${this.connections.size} device(s) (${totalSockets} socket(s))`);
    for (const [deviceId, sockets] of this.connections) {
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) {
          socket.send(message);
        }
      }
      console.log(`[WS] Sent ${event.type} to device ${deviceId} (${sockets.size} socket(s))`);
    }
  }

  /**
   * Send an event to a specific device by deviceId (all sockets for that device).
   */
  broadcastToDevice(deviceId: string, event: WebSocketEvent): void {
    const sockets = this.connections.get(deviceId);
    if (!sockets) return;
    const message = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  }

  /**
   * Broadcast an event to all connected devices EXCEPT the specified one.
   */
  broadcastExcept(excludeDeviceId: string, event: WebSocketEvent): void {
    const message = JSON.stringify(event);
    for (const [deviceId, sockets] of this.connections) {
      if (deviceId !== excludeDeviceId) {
        for (const socket of sockets) {
          if (socket.readyState === socket.OPEN) {
            socket.send(message);
          }
        }
      }
    }
  }

  /**
   * Get the number of connected devices (not sockets).
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Check if a specific device has at least one active connection.
   */
  isDeviceConnected(deviceId: string): boolean {
    const sockets = this.connections.get(deviceId);
    if (!sockets || sockets.size === 0) return false;
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) return true;
    }
    return false;
  }

  /**
   * Get all connected device IDs.
   */
  getConnectedDeviceIds(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Close all connections. Used during server shutdown.
   */
  closeAll(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const [, sockets] of this.connections) {
      for (const socket of sockets) {
        socket.close(1001, 'Server shutting down');
      }
    }
    this.connections.clear();
  }

  /**
   * Handle an incoming message from a client WebSocket connection.
   * Currently supports: ice_candidate messages for WebRTC trickle ICE.
   */
  private handleIncomingMessage(socket: WebSocket, data: unknown): void {
    const deviceId = this.socketToDevice.get(socket);
    if (!deviceId) return;

    let message: unknown;
    try {
      const text = typeof data === 'string' ? data : (data as Buffer).toString('utf-8');
      message = JSON.parse(text);
    } catch {
      // Ignore malformed messages
      return;
    }

    if (!message || typeof message !== 'object') return;

    const msg = message as Record<string, unknown>;

    if (msg.type === 'ice_candidate') {
      // Validate the ice_candidate message shape
      if (typeof msg.callId !== 'string' || !msg.callId) return;
      if (!msg.candidate || typeof msg.candidate !== 'object') return;

      const candidate = msg.candidate as Record<string, unknown>;
      if (typeof candidate.candidate !== 'string') return;
      if (typeof candidate.sdpMid !== 'string') return;
      if (typeof candidate.sdpMLineIndex !== 'number') return;

      const iceCandidateMessage: IceCandidateMessage = {
        type: 'ice_candidate',
        callId: msg.callId,
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        },
      };

      if (this.incomingMessageHandler) {
        try {
          this.incomingMessageHandler(deviceId, iceCandidateMessage);
        } catch {
          // Ignore handler errors — don't crash the connection
        }
      }
    }
    // Other message types are silently ignored
  }

  /**
   * Start a periodic ping to all connected sockets.
   * Any socket that doesn't respond with a pong before the next ping cycle
   * is considered dead. We send a close frame first so well-behaved clients
   * can detect the disconnection and reconnect. If the socket is truly
   * unreachable the close frame will fail silently and the socket is removed.
   */
  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      for (const [deviceId, sockets] of this.connections) {
        for (const socket of sockets) {
          if (!this.aliveSet.has(socket)) {
            // No pong received since last ping — close gracefully
            console.log(`[WS] Closing unresponsive socket for device ${deviceId}`);
            socket.close(1001, 'Ping timeout');
            sockets.delete(socket);
          } else {
            // Mark as not-alive; will be set back to alive when pong arrives
            this.aliveSet.delete(socket);
            socket.ping();
          }
        }
        if (sockets.size === 0) {
          this.connections.delete(deviceId);
        }
      }
    }, WebSocketBroadcaster.PING_INTERVAL_MS);
  }
}
