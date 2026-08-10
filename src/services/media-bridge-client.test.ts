import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MediaBridgeClient,
  MediaBridgeError,
  MediaBridgeUnavailableError,
  type MediaBridgeClientConfig,
  type SessionConfig,
  type SessionInfo,
  type OfferResult,
  type SessionStatus,
  type HealthStatus,
} from './media-bridge-client.js';

// ─── Mock fetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response;
}

function noContentResponse(): Response {
  return {
    ok: true,
    status: 204,
    json: async () => { throw new Error('No content'); },
    text: async () => '',
    headers: new Headers(),
  } as unknown as Response;
}

// ─── Test setup ──────────────────────────────────────────────────────────────

function createClient(overrides?: Partial<MediaBridgeClientConfig>): MediaBridgeClient {
  return new MediaBridgeClient({
    baseUrl: 'http://localhost:9090',
    healthCheckInterval: 5000,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  });
}

describe('MediaBridgeClient', () => {
  let client: MediaBridgeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    client = createClient();
  });

  afterEach(() => {
    client.stopHealthChecks();
    vi.useRealTimers();
  });

  describe('createSession', () => {
    it('should POST to /sessions and return session info', async () => {
      const sessionInfo: SessionInfo = {
        sessionId: 'test-session-1',
        status: 'CREATED',
        sipUri: 'sip:test-session-1@mediabridge:5060',
        audioWsUrl: 'ws://mediabridge:9091/audio/test-session-1',
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(sessionInfo));

      const config: SessionConfig = {
        sessionId: 'test-session-1',
        providerLeg: { type: 'sip', uri: 'sip:conference@provider.com' },
        options: { ringback: true },
      };

      const result = await client.createSession(config);

      expect(result).toEqual(sessionInfo);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9090/sessions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            sessionId: 'test-session-1',
            providerLeg: { type: 'sip', uri: 'sip:conference@provider.com' },
            options: { ringback: true },
          }),
        }),
      );
    });

    it('should handle pending provider leg type', async () => {
      const sessionInfo: SessionInfo = {
        sessionId: 'session-2',
        status: 'CREATED',
        sipUri: 'sip:session-2@mediabridge:5060',
        audioWsUrl: 'ws://mediabridge:9091/audio/session-2',
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(sessionInfo));

      const config: SessionConfig = {
        sessionId: 'session-2',
        providerLeg: { type: 'pending' },
      };

      const result = await client.createSession(config);

      expect(result).toEqual(sessionInfo);
    });

    it('should throw MediaBridgeError on non-2xx response', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Session already exists' }, 409),
      );

      const config: SessionConfig = {
        sessionId: 'dup-session',
        providerLeg: { type: 'pending' },
      };

      await expect(client.createSession(config)).rejects.toThrow(MediaBridgeError);
    });

    it('should include status code in MediaBridgeError', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Session already exists' }, 409),
      );

      const config: SessionConfig = {
        sessionId: 'dup-session',
        providerLeg: { type: 'pending' },
      };

      await expect(client.createSession(config)).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it('should throw MediaBridgeUnavailableError when fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const config: SessionConfig = {
        sessionId: 'fail-session',
        providerLeg: { type: 'pending' },
      };

      await expect(client.createSession(config)).rejects.toThrow(MediaBridgeUnavailableError);
    });
  });

  describe('submitOffer', () => {
    it('should POST SDP offer and return answer with ICE candidates', async () => {
      const offerResult: OfferResult = {
        sdpAnswer: 'v=0\r\no=- answer',
        iceCandidates: [
          { candidate: 'candidate:1 1 TCP 2130706431 192.168.1.1 8443 typ host', sdpMid: '0', sdpMLineIndex: 0 },
        ],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(offerResult));

      const result = await client.submitOffer('session-1', 'v=0\r\no=- offer');

      expect(result).toEqual(offerResult);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9090/sessions/session-1/offer',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sdpOffer: 'v=0\r\no=- offer' }),
        }),
      );
    });

    it('should encode sessionId in URL', async () => {
      const offerResult: OfferResult = {
        sdpAnswer: 'v=0\r\no=- answer',
        iceCandidates: [],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(offerResult));

      await client.submitOffer('session/with/slashes', 'v=0\r\no=- offer');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9090/sessions/session%2Fwith%2Fslashes/offer',
        expect.anything(),
      );
    });
  });

  describe('updateSession', () => {
    it('should PATCH session with provider leg update', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ACTIVE' }));

      await client.updateSession('session-1', {
        providerLeg: { type: 'sip', uri: 'sip:new-uri@provider.com' },
        ringback: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9090/sessions/session-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            providerLeg: { type: 'sip', uri: 'sip:new-uri@provider.com' },
            ringback: false,
          }),
        }),
      );
    });
  });

  describe('destroySession', () => {
    it('should DELETE session and handle 204 response', async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      await expect(client.destroySession('session-1')).resolves.toBeUndefined();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9090/sessions/session-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('should throw MediaBridgeError on 404', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Session not found' }, 404),
      );

      await expect(client.destroySession('nonexistent')).rejects.toThrow(MediaBridgeError);
    });
  });

  describe('getSessionStatus', () => {
    it('should GET session status', async () => {
      const status: SessionStatus = {
        sessionId: 'session-1',
        status: 'ACTIVE',
        clientConnected: true,
        providerConnected: true,
        durationSeconds: 45,
        codec: 'opus/48000/2',
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(status));

      const result = await client.getSessionStatus('session-1');

      expect(result).toEqual(status);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9090/sessions/session-1',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('isHealthy', () => {
    it('should return true when health endpoint returns ok', async () => {
      const healthStatus: HealthStatus = {
        status: 'ok',
        activeSessions: 2,
        uptime: 3600,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(healthStatus));

      const result = await client.isHealthy();

      expect(result).toBe(true);
    });

    it('should return false when health endpoint returns non-ok status', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'degraded', activeSessions: 0, uptime: 0 }));

      const result = await client.isHealthy();

      expect(result).toBe(false);
    });

    it('should return false when health endpoint is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await client.isHealthy();

      expect(result).toBe(false);
    });

    it('should return false when health endpoint returns non-2xx', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'Internal Server Error' }, 500));

      const result = await client.isHealthy();

      expect(result).toBe(false);
    });
  });

  describe('health check polling', () => {
    it('should poll health at configured interval', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', activeSessions: 0, uptime: 0 }));

      client.startHealthChecks();

      // Initial immediate check
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // After one interval
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // After two intervals
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should update isCurrentlyHealthy based on poll results', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok', activeSessions: 0, uptime: 0 }));

      expect(client.isCurrentlyHealthy).toBe(false);

      client.startHealthChecks();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.isCurrentlyHealthy).toBe(true);
    });

    it('should mark unhealthy when poll fails', async () => {
      // First poll succeeds
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok', activeSessions: 0, uptime: 0 }));
      client.startHealthChecks();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.isCurrentlyHealthy).toBe(true);

      // Second poll fails
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await vi.advanceTimersByTimeAsync(5000);
      expect(client.isCurrentlyHealthy).toBe(false);
    });

    it('should not start multiple polling loops', () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', activeSessions: 0, uptime: 0 }));

      client.startHealthChecks();
      client.startHealthChecks(); // second call should be a no-op

      // Verify only one timer was started (only one immediate call)
      // We'll check by advancing time and verifying call count
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should stop polling on stopHealthChecks', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', activeSessions: 0, uptime: 0 }));

      client.startHealthChecks();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      client.stopHealthChecks();

      await vi.advanceTimersByTimeAsync(5000);
      // No additional call since polling stopped
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should use custom health check interval', async () => {
      const customClient = createClient({ healthCheckInterval: 10000 });
      mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', activeSessions: 0, uptime: 0 }));

      customClient.startHealthChecks();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // 5s — no new call (interval is 10s)
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // 10s — new call
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      customClient.stopHealthChecks();
    });

    it('should log when health transitions from healthy to unhealthy', async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const logClient = createClient({ logger });

      // First poll: healthy
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok', activeSessions: 0, uptime: 0 }));
      logClient.startHealthChecks();
      await vi.advanceTimersByTimeAsync(0);

      expect(logger.info).toHaveBeenCalledWith('MediaBridge is now healthy');

      // Second poll: unhealthy
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await vi.advanceTimersByTimeAsync(5000);

      expect(logger.warn).toHaveBeenCalledWith('MediaBridge health check failed — marking as unavailable');

      logClient.stopHealthChecks();
    });
  });

  describe('default configuration', () => {
    it('should use default baseUrl when not specified', async () => {
      const defaultClient = createClient({ baseUrl: undefined });
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok', activeSessions: 0, uptime: 0 }));

      await defaultClient.isHealthy();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9090/health',
        expect.anything(),
      );
    });

    it('should strip trailing slash from baseUrl', async () => {
      const slashClient = createClient({ baseUrl: 'http://localhost:9090/' });
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok', activeSessions: 0, uptime: 0 }));

      await slashClient.isHealthy();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9090/health',
        expect.anything(),
      );
    });
  });
});
