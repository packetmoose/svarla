import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerCallRoutes } from './call-routes.js';
import type { CallHistoryService } from '../services/call-history-service.js';
import type { PaginatedHistory, CallHistoryEntry } from '../services/call-history-service.js';
import type { CallOrchestrator } from '../services/call-orchestrator.js';
import { CallOrchestratorError } from '../services/call-orchestrator.js';

function createMockCallHistoryService(): CallHistoryService {
  return {
    recordCall: vi.fn().mockResolvedValue({ id: 'new-id', phone_number: '+14155551234', provider_number: null, call_type: 'OUTGOING', timestamp: new Date(), duration_seconds: null, provider_call_id: null, answered_by_device: null }),
    getHistory: vi.fn(),
    getRecentHistory: vi.fn(),
    updateCallTypeByProviderCallId: vi.fn(),
    updateDurationByProviderCallId: vi.fn(),
    markOutboundUnanswered: vi.fn(),
    markAnswered: vi.fn().mockResolvedValue(undefined),
  } as unknown as CallHistoryService;
}

function createMockCallOrchestrator(): CallOrchestrator {
  return {
    initiateOutbound: vi.fn().mockResolvedValue({ callId: 'new-call-id', from: '+14155550000', to: '+14155551234' }),
    answerCall: vi.fn().mockResolvedValue({ success: true }),
    endCall: vi.fn().mockResolvedValue(undefined),
    handleWebRtcOffer: vi.fn().mockResolvedValue({ sdpAnswer: 'v=0\r\n...', iceCandidates: [] }),
    handleInbound: vi.fn(),
    handleMediaEvent: vi.fn(),
    getAllActiveCalls: vi.fn().mockReturnValue([]),
    getActiveCall: vi.fn().mockReturnValue({ callId: 'call-1', from: '+14155550000', to: '+14155551234', direction: 'outbound', answered: true }),
    getCallIdByProviderCallId: vi.fn(),
    endAllCalls: vi.fn(),
    dispose: vi.fn(),
  } as unknown as CallOrchestrator;
}

function makeCallEntry(overrides: Partial<CallHistoryEntry> = {}): CallHistoryEntry {
  return {
    id: 'uuid-1',
    phone_number: '+14155551234',
    provider_number: '+14155550000',
    call_type: 'INCOMING',
    timestamp: new Date('2024-01-15T10:30:00Z'),
    duration_seconds: 120,
    provider_call_id: 'vonage-123',
    answered_by_device: 'device-1',
    ...overrides,
  };
}

describe('Call Routes', () => {
  let server: FastifyInstance;
  let mockService: CallHistoryService;
  let mockOrchestrator: CallOrchestrator;

  beforeEach(async () => {
    server = Fastify();
    mockService = createMockCallHistoryService();
    mockOrchestrator = createMockCallOrchestrator();

    // Simulate session middleware by decorating the request with deviceId
    server.decorateRequest('deviceId', '');
    server.decorateRequest('deviceName', '');
    server.decorateRequest('sessionToken', '');
    server.addHook('onRequest', async (request) => {
      request.deviceId = 'test-device-id';
      request.deviceName = 'Test Device';
    });

    registerCallRoutes(server, mockService, mockOrchestrator);
    await server.ready();
  });

  describe('GET /api/calls/history', () => {
    it('should return paginated call history with default params', async () => {
      const mockResult: PaginatedHistory = {
        entries: [makeCallEntry()],
        page: 1,
        pageSize: 50,
        total: 1,
        totalPages: 1,
      };
      (mockService.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const response = await server.inject({
        method: 'GET',
        url: '/api/calls/history',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].phoneNumber).toBe('+14155551234');
      expect(body.entries[0].providerNumber).toBe('+14155550000');
      expect(body.entries[0].callType).toBe('INCOMING');
      expect(body.entries[0].durationSeconds).toBe(120);
      expect(body.entries[0].timestamp).toBe('2024-01-15T10:30:00.000Z');
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(50);
      expect(body.total).toBe(1);
      expect(body.totalPages).toBe(1);
      expect(mockService.getHistory).toHaveBeenCalledWith(1, 50, undefined);
    });

    it('should pass custom page and pageSize from query params', async () => {
      const mockResult: PaginatedHistory = {
        entries: [],
        page: 3,
        pageSize: 20,
        total: 0,
        totalPages: 0,
      };
      (mockService.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const response = await server.inject({
        method: 'GET',
        url: '/api/calls/history?page=3&pageSize=20',
      });

      expect(response.statusCode).toBe(200);
      expect(mockService.getHistory).toHaveBeenCalledWith(3, 20, undefined);
    });

    it('should return multiple entries with correct field mapping', async () => {
      const mockResult: PaginatedHistory = {
        entries: [
          makeCallEntry({ id: '1', call_type: 'OUTGOING', duration_seconds: 60 }),
          makeCallEntry({ id: '2', call_type: 'MISSED', duration_seconds: null }),
          makeCallEntry({ id: '3', call_type: 'UNANSWERED', duration_seconds: null }),
        ],
        page: 1,
        pageSize: 50,
        total: 3,
        totalPages: 1,
      };
      (mockService.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const response = await server.inject({
        method: 'GET',
        url: '/api/calls/history',
      });

      const body = JSON.parse(response.body);
      expect(body.entries).toHaveLength(3);
      expect(body.entries[0].callType).toBe('OUTGOING');
      expect(body.entries[1].callType).toBe('MISSED');
      expect(body.entries[1].durationSeconds).toBeNull();
      expect(body.entries[2].callType).toBe('UNANSWERED');
    });
  });

  describe('POST /api/calls/make', () => {
    it('should delegate to CallOrchestrator.initiateOutbound and return {callId, from, to}', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/make',
        payload: { from: '+14155550000', to: '+14155551234' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.callId).toBe('new-call-id');
      expect(body.from).toBe('+14155550000');
      expect(body.to).toBe('+14155551234');
      // No provider-specific fields (no clientToken etc.)
      expect(body.clientToken).toBeUndefined();
      expect(mockOrchestrator.initiateOutbound).toHaveBeenCalledWith(
        'test-device-id',
        '+14155550000',
        '+14155551234',
      );
    });

    it('should return 400 when from or to is missing', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/make',
        payload: { from: '+14155550000' },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Missing required fields');
    });

    it('should return 400 for invalid phone number', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/make',
        payload: { from: '+14155550000', to: 'not-a-number' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 503 when CallOrchestrator throws CallOrchestratorError', async () => {
      (mockOrchestrator.initiateOutbound as ReturnType<typeof vi.fn>).mockRejectedValue(
        new CallOrchestratorError('Media service is unavailable'),
      );

      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/make',
        payload: { from: '+14155550000', to: '+14155551234' },
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Media service is unavailable');
    });

    it('should normalize local numbers using from country code', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/make',
        payload: { from: '+46701234567', to: '0701234568' },
      });

      expect(response.statusCode).toBe(200);
      // normalizeToE164('0701234568', '+46701234567') → '+46701234568'
      expect(mockOrchestrator.initiateOutbound).toHaveBeenCalledWith(
        'test-device-id',
        '+46701234567',
        '+46701234568',
      );
    });
  });

  describe('POST /api/calls/answer/:callId', () => {
    it('should delegate to CallOrchestrator.answerCall and return success', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/answer/call-uuid-123',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      // No provider-specific fields (no clientToken)
      expect(body.clientToken).toBeUndefined();
      expect(mockOrchestrator.answerCall).toHaveBeenCalledWith('call-uuid-123', 'test-device-id');
    });

    it('should return 409 when call is already answered', async () => {
      (mockOrchestrator.answerCall as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        errorReason: 'Call already answered by another device',
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/answer/call-uuid-123',
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Call already answered by another device');
    });

    it('should return 400 when callId is empty', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/answer/%20',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/calls/decline/:callId', () => {
    it('should delegate to CallOrchestrator.endCall and return success', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/decline/call-uuid-456',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(mockOrchestrator.endCall).toHaveBeenCalledWith('call-uuid-456', 'declined');
    });

    it('should return 500 on orchestrator error', async () => {
      (mockOrchestrator.endCall as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Something went wrong'),
      );

      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/decline/call-uuid-456',
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Something went wrong');
    });
  });

  describe('POST /api/calls/:callId/dtmf', () => {
    it('should accept a valid DTMF digit and return success', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/call-uuid-789/dtmf',
        payload: { digit: '5' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.digit).toBe('5');
    });

    it('should accept * and # as valid DTMF digits', async () => {
      const response1 = await server.inject({
        method: 'POST',
        url: '/api/calls/call-uuid-789/dtmf',
        payload: { digit: '*' },
      });
      expect(response1.statusCode).toBe(200);

      const response2 = await server.inject({
        method: 'POST',
        url: '/api/calls/call-uuid-789/dtmf',
        payload: { digit: '#' },
      });
      expect(response2.statusCode).toBe(200);
    });

    it('should return 400 for invalid DTMF digit', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/call-uuid-789/dtmf',
        payload: { digit: 'A' },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('digit is required');
    });

    it('should return 400 when digit is missing', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/call-uuid-789/dtmf',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for multi-character digit string', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/call-uuid-789/dtmf',
        payload: { digit: '12' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 404 when call is not found', async () => {
      (mockOrchestrator.getActiveCall as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const response = await server.inject({
        method: 'POST',
        url: '/api/calls/unknown-call/dtmf',
        payload: { digit: '5' },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Call not found');
    });
  });

  describe('GET /api/calls/active', () => {
    it('should delegate to CallOrchestrator.getAllActiveCalls', async () => {
      const mockCalls = [
        { callId: 'call-1', from: '+14155550000', to: '+14155551234', direction: 'outbound', status: 'connected', providerNumber: '+14155550000', startedAt: 1700000000000 },
      ];
      (mockOrchestrator.getAllActiveCalls as ReturnType<typeof vi.fn>).mockReturnValue(mockCalls);

      const response = await server.inject({
        method: 'GET',
        url: '/api/calls/active',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.calls).toHaveLength(1);
      expect(body.calls[0].callId).toBe('call-1');
      expect(body.calls[0].providerNumber).toBe('+14155550000');
      // No vonageNumber field
      expect(body.calls[0].vonageNumber).toBeUndefined();
      expect(mockOrchestrator.getAllActiveCalls).toHaveBeenCalled();
    });

    it('should return empty array when no calls are active', async () => {
      (mockOrchestrator.getAllActiveCalls as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const response = await server.inject({
        method: 'GET',
        url: '/api/calls/active',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.calls).toEqual([]);
    });
  });

  describe('Routes without CallOrchestrator', () => {
    let serverNoOrch: FastifyInstance;

    beforeEach(async () => {
      serverNoOrch = Fastify();
      const service = createMockCallHistoryService();

      serverNoOrch.decorateRequest('deviceId', '');
      serverNoOrch.decorateRequest('deviceName', '');
      serverNoOrch.decorateRequest('sessionToken', '');
      serverNoOrch.addHook('onRequest', async (request) => {
        request.deviceId = 'test-device-id';
        request.deviceName = 'Test Device';
      });

      // Register without orchestrator
      registerCallRoutes(serverNoOrch, service);
      await serverNoOrch.ready();
    });

    it('POST /api/calls/make should return 503 when orchestrator is unavailable', async () => {
      const response = await serverNoOrch.inject({
        method: 'POST',
        url: '/api/calls/make',
        payload: { from: '+14155550000', to: '+14155551234' },
      });

      expect(response.statusCode).toBe(503);
    });

    it('POST /api/calls/answer/:callId should return 503 when orchestrator is unavailable', async () => {
      const response = await serverNoOrch.inject({
        method: 'POST',
        url: '/api/calls/answer/call-123',
      });

      expect(response.statusCode).toBe(503);
    });

    it('POST /api/calls/decline/:callId should return 503 when orchestrator is unavailable', async () => {
      const response = await serverNoOrch.inject({
        method: 'POST',
        url: '/api/calls/decline/call-123',
      });

      expect(response.statusCode).toBe(503);
    });

    it('GET /api/calls/active should return empty calls array', async () => {
      const response = await serverNoOrch.inject({
        method: 'GET',
        url: '/api/calls/active',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.calls).toEqual([]);
    });
  });
});
