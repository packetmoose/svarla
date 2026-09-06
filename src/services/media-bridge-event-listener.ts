import WebSocket from 'ws';

/**
 * Session event types emitted by the MediaBridge.
 */
export type MediaBridgeSessionEventType =
  | 'client_connected'
  | 'provider_connected'
  | 'client_disconnected'
  | 'provider_disconnected'
  | 'dtmf'
  | 'ice_candidate';

/**
 * A session event from the MediaBridge.
 */
export interface MediaBridgeSessionEvent {
  type: 'session_event';
  sessionId: string;
  event: MediaBridgeSessionEventType;
  /** Present for client_disconnected and provider_disconnected */
  reason?: string;
  /** Present for dtmf events */
  digit?: string;
  /** Present for ice_candidate events */
  candidate?: {
    candidate: string;
    sdpMid: string;
    sdpMLineIndex: number;
  };
}

/**
 * A health event from the MediaBridge.
 */
export interface MediaBridgeHealthEvent {
  type: 'health';
  activeSessions: number;
  uptime: number;
}

/**
 * Union of all MediaBridge event types.
 */
export type MediaBridgeEvent = MediaBridgeSessionEvent | MediaBridgeHealthEvent;

/**
 * Handler callback for session events routed to the CallOrchestrator.
 */
export type SessionEventHandler = (event: MediaBridgeSessionEvent) => void;

/**
 * Handler invoked when the event WebSocket reconnects after a prior disconnect.
 * Used to reconcile call state, since events emitted while disconnected are lost.
 */
export type ReconnectHandler = () => void;

/**
 * Health status of the MediaBridge connection.
 */
export interface MediaBridgeHealthStatus {
  connected: boolean;
  lastHealthEvent: MediaBridgeHealthEvent | null;
  lastHealthEventAt: Date | null;
}

/**
 * Logger interface matching Fastify/Pino logger shape.
 */
export interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Configuration for the MediaBridge event listener.
 */
export interface MediaBridgeEventListenerConfig {
  /** WebSocket URL to connect to on the MediaBridge (e.g. ws://localhost:9090/events) */
  url: string;
  /** Reconnection interval in milliseconds. Default: 3000 */
  reconnectInterval?: number;
  /** Logger instance */
  logger?: Logger;
}

const VALID_SESSION_EVENTS: Set<string> = new Set([
  'client_connected',
  'provider_connected',
  'client_disconnected',
  'provider_disconnected',
  'dtmf',
  'ice_candidate',
]);

const DEFAULT_RECONNECT_INTERVAL = 3000;

/**
 * MediaBridgeEventListener connects as a WebSocket client to the MediaBridge's
 * /events endpoint and receives session events and health updates.
 *
 * Features:
 * - Connects to the MediaBridge event WebSocket endpoint
 * - Automatically reconnects on disconnect
 * - Parses and validates incoming JSON messages
 * - Routes session events to registered handler (CallOrchestrator)
 * - Tracks MediaBridge health status (connected, last health event)
 */
export class MediaBridgeEventListener {
  private readonly url: string;
  private readonly reconnectInterval: number;
  private readonly logger: Logger;
  private ws: WebSocket | null = null;
  private sessionEventHandler: SessionEventHandler | null = null;
  private reconnectHandler: ReconnectHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** True once the socket has connected at least once, so we can tell a reconnect from the first connect. */
  private hasConnectedBefore = false;
  private healthStatus: MediaBridgeHealthStatus = {
    connected: false,
    lastHealthEvent: null,
    lastHealthEventAt: null,
  };

  constructor(config: MediaBridgeEventListenerConfig) {
    this.url = config.url;
    this.reconnectInterval = config.reconnectInterval ?? DEFAULT_RECONNECT_INTERVAL;
    this.logger = config.logger ?? createConsoleLogger();
  }

  /**
   * Register a handler for session events. This will typically be the
   * CallOrchestrator's handleMediaEvent method.
   */
  onSessionEvent(handler: SessionEventHandler): void {
    this.sessionEventHandler = handler;
  }

  /**
   * Register a handler invoked when the event socket reconnects after a drop.
   * Not called on the initial connection — only on genuine reconnects.
   */
  onReconnect(handler: ReconnectHandler): void {
    this.reconnectHandler = handler;
  }

  /**
   * Get the current health status of the MediaBridge connection.
   */
  getHealthStatus(): MediaBridgeHealthStatus {
    return { ...this.healthStatus };
  }

  /**
   * Whether the MediaBridge event WebSocket is currently connected.
   */
  isConnected(): boolean {
    return this.healthStatus.connected;
  }

  /**
   * Start the WebSocket client — connects to the MediaBridge and auto-reconnects.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  /**
   * Stop the WebSocket client and close the connection.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client shutting down');
      this.ws = null;
    }

    this.healthStatus.connected = false;
  }

  /**
   * Establish the WebSocket connection to the MediaBridge.
   */
  private connect(): void {
    if (this.stopped) return;

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.logger.warn(
        { err, url: this.url } as Record<string, unknown>,
        'MediaBridge event WebSocket connection failed'
      );
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.healthStatus.connected = true;
      this.logger.info(`Connected to MediaBridge event WebSocket at ${this.url}`);
      // On a genuine reconnect (not the first connect), notify the handler so it
      // can reconcile call state — session events emitted while we were
      // disconnected are lost and never redelivered.
      if (this.hasConnectedBefore && this.reconnectHandler) {
        try {
          this.reconnectHandler();
        } catch (err) {
          this.logger.warn(
            { err } as Record<string, unknown>,
            'MediaBridge reconnect handler threw',
          );
        }
      }
      this.hasConnectedBefore = true;
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.healthStatus.connected = false;
      this.logger.info(
        { code, reason: reason.toString() } as Record<string, unknown>,
        'MediaBridge event WebSocket disconnected'
      );
      this.ws = null;
      this.scheduleReconnect();
    });

    this.ws.on('error', (error: Error) => {
      this.logger.warn(
        { err: error, url: this.url } as Record<string, unknown>,
        'MediaBridge event WebSocket error'
      );
      // The 'close' event will follow and handle reconnection.
    });
  }

  /**
   * Schedule a reconnection attempt after the configured interval.
   */
  private scheduleReconnect(): void {
    if (this.stopped) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }

  /**
   * Parse and dispatch an incoming WebSocket message from the MediaBridge.
   */
  private handleMessage(data: WebSocket.Data): void {
    let message: unknown;
    try {
      const text = typeof data === 'string' ? data : (data as Buffer).toString('utf-8');
      message = JSON.parse(text);
    } catch {
      this.logger.warn('MediaBridge sent invalid JSON message — ignoring');
      return;
    }

    if (!message || typeof message !== 'object') {
      this.logger.warn('MediaBridge sent non-object message — ignoring');
      return;
    }

    const msg = message as Record<string, unknown>;

    if (msg.type === 'session_event') {
      this.handleSessionEvent(msg);
    } else if (msg.type === 'health') {
      this.handleHealthEvent(msg);
    } else {
      this.logger.debug(`MediaBridge sent unknown message type: ${String(msg.type)} — ignoring`);
    }
  }

  /**
   * Validate and dispatch a session event.
   */
  private handleSessionEvent(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId;
    const event = msg.event;

    if (typeof sessionId !== 'string' || !sessionId) {
      this.logger.warn('MediaBridge session_event missing sessionId — ignoring');
      return;
    }

    if (typeof event !== 'string' || !VALID_SESSION_EVENTS.has(event)) {
      this.logger.warn(
        { event } as Record<string, unknown>,
        'MediaBridge session_event has invalid event type — ignoring'
      );
      return;
    }

    const sessionEvent: MediaBridgeSessionEvent = {
      type: 'session_event',
      sessionId,
      event: event as MediaBridgeSessionEventType,
    };

    // Include optional fields
    if (typeof msg.reason === 'string') {
      sessionEvent.reason = msg.reason;
    }
    if (typeof msg.digit === 'string') {
      sessionEvent.digit = msg.digit;
    }
    if (msg.candidate && typeof msg.candidate === 'object') {
      const c = msg.candidate as Record<string, unknown>;
      if (typeof c.candidate === 'string' && typeof c.sdpMid === 'string' && typeof c.sdpMLineIndex === 'number') {
        sessionEvent.candidate = {
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
        };
      }
    }

    this.logger.debug(
      { sessionId, event, reason: sessionEvent.reason, digit: sessionEvent.digit } as Record<string, unknown>,
      'MediaBridge session event received'
    );

    if (this.sessionEventHandler) {
      try {
        this.sessionEventHandler(sessionEvent);
      } catch (error) {
        this.logger.error(
          { err: error, sessionId, event } as Record<string, unknown>,
          'Error in session event handler'
        );
      }
    }
  }

  /**
   * Process a health event from the MediaBridge.
   */
  private handleHealthEvent(msg: Record<string, unknown>): void {
    const activeSessions = typeof msg.activeSessions === 'number' ? msg.activeSessions : 0;
    const uptime = typeof msg.uptime === 'number' ? msg.uptime : 0;

    const healthEvent: MediaBridgeHealthEvent = {
      type: 'health',
      activeSessions,
      uptime,
    };

    this.healthStatus.lastHealthEvent = healthEvent;
    this.healthStatus.lastHealthEventAt = new Date();

    this.logger.debug(
      { activeSessions, uptime } as Record<string, unknown>,
      'MediaBridge health event received'
    );
  }
}

/**
 * Default console logger when no Pino/Fastify logger is provided.
 */
function createConsoleLogger(): Logger {
  return {
    info(...args: unknown[]) {
      if (typeof args[0] === 'string') {
        console.log(`[MediaBridgeEventListener] ${args[0]}`);
      } else {
        console.log(`[MediaBridgeEventListener] ${args[1]}`, args[0]);
      }
    },
    warn(...args: unknown[]) {
      if (typeof args[0] === 'string') {
        console.warn(`[MediaBridgeEventListener] ${args[0]}`);
      } else {
        console.warn(`[MediaBridgeEventListener] ${args[1]}`, args[0]);
      }
    },
    error(...args: unknown[]) {
      if (typeof args[0] === 'string') {
        console.error(`[MediaBridgeEventListener] ${args[0]}`);
      } else {
        console.error(`[MediaBridgeEventListener] ${args[1]}`, args[0]);
      }
    },
    debug(...args: unknown[]) {
      if (typeof args[0] === 'string') {
        console.debug(`[MediaBridgeEventListener] ${args[0]}`);
      } else {
        console.debug(`[MediaBridgeEventListener] ${args[1]}`, args[0]);
      }
    },
  };
}
