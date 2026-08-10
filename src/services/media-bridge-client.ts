/**
 * MediaBridgeClient — HTTP client for the MediaBridge ControlAPI.
 *
 * Communicates with the MediaBridge sidecar (Pion/Go) to manage audio sessions.
 * The ControlAPI is a REST API on a localhost-only port (default 9090).
 *
 * Requirements: 4.3, 4.6, 5.1
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProviderLegConfig =
  | { type: 'sip'; uri: string }
  | { type: 'websocket'; url?: string; protocol?: string; expectedCallId?: string }
  | { type: 'pending' };

export interface AudioTapConfig {
  enabled: boolean;
  endpoint?: string;
}

export interface SessionConfig {
  sessionId: string;
  providerLeg: ProviderLegConfig;
  options?: {
    ringback?: boolean;
    audioTap?: AudioTapConfig;
  };
}

export interface SessionInfo {
  sessionId: string;
  status: string;
  sipUri: string;
  sipsUri?: string;
  audioWsUrl: string;
}

export interface IceCandidate {
  candidate: string;
  sdpMid: string;
  sdpMLineIndex: number;
}

export interface OfferResult {
  sdpAnswer: string;
  iceCandidates: IceCandidate[];
}

export interface SessionPatch {
  providerLeg?: ProviderLegConfig;
  ringback?: boolean;
}

export interface SessionStatus {
  sessionId: string;
  status: string;
  clientConnected: boolean;
  providerConnected: boolean;
  durationSeconds: number;
  codec: string;
}

export interface HealthStatus {
  status: string;
  activeSessions: number;
  uptime: number;
}

export interface MediaBridgeClientLogger {
  info(msg: string): void;
  info(obj: unknown, msg: string): void;
  warn(msg: string): void;
  warn(obj: unknown, msg: string): void;
  error(msg: string): void;
  error(obj: unknown, msg: string): void;
}

export interface MediaBridgeClientConfig {
  /** Base URL of the MediaBridge ControlAPI (default: http://localhost:9090) */
  baseUrl?: string;
  /** Health check polling interval in ms (default: 5000) */
  healthCheckInterval?: number;
  /** Logger instance (compatible with Pino/Fastify logger) */
  logger: MediaBridgeClientLogger;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class MediaBridgeError extends Error {
  readonly statusCode: number;
  readonly responseBody: unknown;

  constructor(message: string, statusCode: number, responseBody?: unknown) {
    super(message);
    this.name = 'MediaBridgeError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class MediaBridgeUnavailableError extends Error {
  constructor(message: string = 'MediaBridge is unavailable') {
    super(message);
    this.name = 'MediaBridgeUnavailableError';
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

/**
 * MediaBridgeClient manages communication with the MediaBridge ControlAPI
 * and monitors its health via periodic polling.
 */
export class MediaBridgeClient {
  private readonly baseUrl: string;
  private readonly healthCheckInterval: number;
  private readonly logger: MediaBridgeClientLogger;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthy = false;

  constructor(config: MediaBridgeClientConfig) {
    this.baseUrl = (config.baseUrl ?? 'http://localhost:9090').replace(/\/$/, '');
    this.healthCheckInterval = config.healthCheckInterval ?? 5000;
    this.logger = config.logger;
  }

  /**
   * Start health check polling. Call this on server startup.
   */
  startHealthChecks(): void {
    if (this.healthCheckTimer !== null) {
      return;
    }

    // Run an initial check immediately
    void this.pollHealth();

    this.healthCheckTimer = setInterval(() => {
      void this.pollHealth();
    }, this.healthCheckInterval);
  }

  /**
   * Stop health check polling. Call this on server shutdown.
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Returns whether the MediaBridge was healthy at the last poll.
   */
  get isCurrentlyHealthy(): boolean {
    return this.healthy;
  }

  /**
   * POST /sessions — Create a new MediaBridge session.
   */
  async createSession(config: SessionConfig): Promise<SessionInfo> {
    const response = await this.request<SessionInfo>('POST', '/sessions', {
      sessionId: config.sessionId,
      providerLeg: config.providerLeg,
      options: config.options,
    });
    return response;
  }

  /**
   * POST /sessions/:sessionId/offer — Submit an SDP offer, get back an answer.
   */
  async submitOffer(sessionId: string, sdpOffer: string): Promise<OfferResult> {
    const response = await this.request<OfferResult>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/offer`,
      { sdpOffer },
    );
    return response;
  }

  /**
   * PATCH /sessions/:sessionId — Update session configuration.
   */
  async updateSession(sessionId: string, patch: SessionPatch): Promise<void> {
    await this.request<unknown>(
      'PATCH',
      `/sessions/${encodeURIComponent(sessionId)}`,
      patch,
    );
  }

  /**
   * DELETE /sessions/:sessionId — Destroy a session.
   */
  async destroySession(sessionId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  /**
   * GET /sessions/:sessionId — Get current session status.
   */
  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const response = await this.request<SessionStatus>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    return response;
  }

  /**
   * GET /health — Check if the MediaBridge is healthy.
   * Returns true if healthy, false if unreachable or unhealthy.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as HealthStatus;
      return body.status === 'ok';
    } catch {
      return false;
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /**
   * Generic HTTP request helper. Throws on non-2xx responses.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new MediaBridgeUnavailableError(
        `Failed to connect to MediaBridge at ${url}: ${(err as Error).message}`,
      );
    }

    // 204 No Content (e.g., DELETE) — return without parsing body
    if (response.status === 204) {
      return undefined as T;
    }

    if (!response.ok) {
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = await response.text().catch(() => null);
      }
      throw new MediaBridgeError(
        `MediaBridge request failed: ${method} ${path} returned ${response.status}`,
        response.status,
        responseBody,
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Poll the health endpoint and update internal state.
   */
  private async pollHealth(): Promise<void> {
    const wasHealthy = this.healthy;
    this.healthy = await this.isHealthy();

    if (wasHealthy && !this.healthy) {
      this.logger.warn('MediaBridge health check failed — marking as unavailable');
    } else if (!wasHealthy && this.healthy) {
      this.logger.info('MediaBridge is now healthy');
    }
  }
}
