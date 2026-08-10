import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerCallRoutes } from './call-routes.js';
import type { CallHistoryService } from '../services/call-history-service.js';
import type { CallOrchestrator } from '../services/call-orchestrator.js';
import { CallNotFoundError, CallOrchestratorError } from '../services/call-orchestrator.js';

function createMockCallHistoryService(): CallHistoryService {
  return {
    recordCall: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ entries: [], page: 1, pageSize: 50, total: 0, totalPages: 0 }),
    getRecentHistory: vi.fn().mockResolvedValue([]),
    updateCallTypeByProviderCallId: vi.fn().mockResolvedValue(undefined),
    updateDurationByProviderCallId: vi.fn().mockResolvedValue(undefined),
    markOutboundUnanswered: vi.fn().mockResolvedValue(undefined),
    markAnswered: vi.fn().mockResolvedValue(undefined),
  } as unknown as CallHistoryService;
}

function createMockCallOrchestrator(overrides: Partial<CallOrchestrator> = {}): CallOrchestrator {
  return {
    initiateOutbound: vi.fn(),
    handleInbound: vi.fn(),
    answerCall: vi.fn().mockResolvedValue({ success: true }),
    endCall: vi.fn().mockResolvedValue(undefined),
    handleWebRtcOffer: vi.fn().mockResolvedValue({
      sdpAnswer: 'v=0\r\no=- 1234 1234 IN IP4 127.0.0.1\r\n',
      iceCandidates: [],
    }),
    handleMediaEvent: vi.fn(),
    getCallIdByProviderCallId: vi.fn(),
    getActiveCall: vi.fn(),
    getAllActiveCalls: vi.fn().mockReturnValue([]),
    endAllCalls: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as CallOrchestrator;
}

describe('POST /api/calls/webrtc/offer', () => {
  let server: FastifyInstance;
  let mockHistoryService: CallHistoryService;
  let mockOrchestrator: CallOrchestrator;

  beforeEach(async () => {
    server = Fastify({ logger: false });
    mockHistoryService = createMockCallHistoryService();
    mockOrchestrator = createMockCallOrchestrator();

    // Simulate session middleware — sets deviceId on authenticated requests
    server.decorateRequest('deviceId', '');
    server.decorateRequest('deviceName', '');
    server.decorateRequest('sessionToken', '');
    server.addHook('onRequest', async (request) => {
      request.deviceId = 'test-device-id';
      request.deviceName = 'Test Device';
    });

    registerCallRoutes(server, mockHistoryService, mockOrchestrator);
    await server.ready();
  });

  it('should return 200 with sdpAnswer for a valid request', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/calls/webrtc/offer',
      payload: {
        sdpOffer: 'v=0\r\no=- 5678 5678 IN IP4 192.168.1.1\r\n',
        callId: 'call-uuid-123',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.sdpAnswer).toBe('v=0\r\no=- 1234 1234 IN IP4 127.0.0.1\r\n');
    expect(mockOrchestrator.handleWebRtcOffer).toHaveBeenCalledWith(
      'call-uuid-123',
      'test-device-id',
      'v=0\r\no=- 5678 5678 IN IP4 192.168.1.1\r\n',
    );
  });

  it('should return 401 when not authenticated', async () => {
    // Create a server without session middleware (simulates unauthenticated)
    const unauthServer = Fastify({ logger: false });
    unauthServer.decorateRequest('deviceId', '');
    unauthServer.decorateRequest('deviceName', '');
    unauthServer.decorateRequest('sessionToken', '');
    // Do NOT set deviceId — simulates unauthenticated request

    registerCallRoutes(unauthServer, mockHistoryService, mockOrchestrator);
    await unauthServer.ready();

    const response = await unauthServer.inject({
      method: 'POST',
      url: '/api/calls/webrtc/offer',
      payload: {
        sdpOffer: 'v=0\r\n',
        callId: 'call-uuid-123',
      },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Authentication required');
  });

  it('should return 400 when sdpOffer is missing', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/calls/webrtc/offer',
      payload: {
        callId: 'call-uuid-123',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('Missing required fields');
  });

  it('should return 400 when callId is missing', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/calls/webrtc/offer',
      payload: {
        sdpOffer: 'v=0\r\n',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('Missing required fields');
  });

  it('should return 404 when call is not found', async () => {
    (mockOrchestrator.handleWebRtcOffer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new CallNotFoundError('call-uuid-missing'),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/calls/webrtc/offer',
      payload: {
        sdpOffer: 'v=0\r\n',
        callId: 'call-uuid-missing',
      },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Call not found');
  });

  it('should return 503 when MediaBridge is unavailable', async () => {
    (mockOrchestrator.handleWebRtcOffer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new CallOrchestratorError('Media service is unavailable'),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/calls/webrtc/offer',
      payload: {
        sdpOffer: 'v=0\r\n',
        callId: 'call-uuid-123',
      },
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Media service unavailable');
  });

  it('should return 503 when callOrchestrator is not provided', async () => {
    const noOrchestratorServer = Fastify({ logger: false });
    noOrchestratorServer.decorateRequest('deviceId', '');
    noOrchestratorServer.decorateRequest('deviceName', '');
    noOrchestratorServer.decorateRequest('sessionToken', '');
    noOrchestratorServer.addHook('onRequest', async (request) => {
      request.deviceId = 'test-device-id';
    });

    // Pass undefined for callOrchestrator
    registerCallRoutes(noOrchestratorServer, mockHistoryService, undefined);
    await noOrchestratorServer.ready();

    const response = await noOrchestratorServer.inject({
      method: 'POST',
      url: '/api/calls/webrtc/offer',
      payload: {
        sdpOffer: 'v=0\r\n',
        callId: 'call-uuid-123',
      },
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Media service unavailable');
  });

  it('should return 504 when signaling times out', async () => {
    // Simulate a slow offer that exceeds 5s
    (mockOrchestrator.handleWebRtcOffer as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10000)),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/calls/webrtc/offer',
      payload: {
        sdpOffer: 'v=0\r\n',
        callId: 'call-uuid-123',
      },
    });

    expect(response.statusCode).toBe(504);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('Signaling timeout');
  }, 10000);

  it('should return 500 for unexpected errors', async () => {
    (mockOrchestrator.handleWebRtcOffer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Unexpected internal error'),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/calls/webrtc/offer',
      payload: {
        sdpOffer: 'v=0\r\n',
        callId: 'call-uuid-123',
      },
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Unexpected internal error');
  });

  it('should pass deviceId from session to callOrchestrator', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/calls/webrtc/offer',
      payload: {
        sdpOffer: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n',
        callId: 'call-abc',
      },
    });

    expect(mockOrchestrator.handleWebRtcOffer).toHaveBeenCalledWith(
      'call-abc',
      'test-device-id',
      'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n',
    );
  });
});
