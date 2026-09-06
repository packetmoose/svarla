import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerReadStateRoutes } from './read-state-routes.js';
import type { ReadStateService } from '../services/read-state-service.js';

describe('Read State Routes', () => {
  let server: FastifyInstance;
  let mockReadStateService: {
    getCounts: ReturnType<typeof vi.fn>;
    markMissedCallsAsViewed: ReturnType<typeof vi.fn>;
    markThreadAsRead: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    server = Fastify();

    mockReadStateService = {
      getCounts: vi.fn().mockResolvedValue({
        unreadMessages: 5,
        unseenMissedCalls: 2,
      }),
      markMissedCallsAsViewed: vi.fn().mockResolvedValue({
        unreadMessages: 5,
        unseenMissedCalls: 0,
      }),
      markThreadAsRead: vi.fn().mockResolvedValue({
        unreadMessages: 3,
        unseenMissedCalls: 2,
      }),
    };

    // Simulate session middleware by decorating the request
    server.addHook('onRequest', async (request) => {
      request.deviceId = 'test-device-id';
    });

    registerReadStateRoutes(server, mockReadStateService as unknown as ReadStateService);
    await server.ready();
  });

  describe('GET /api/read-state/counts', () => {
    it('should return current badge counts', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/read-state/counts',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.unreadMessages).toBe(5);
      expect(body.unseenMissedCalls).toBe(2);
      expect(mockReadStateService.getCounts).toHaveBeenCalled();
    });
  });

  describe('POST /api/read-state/calls', () => {
    it('should mark missed calls as viewed and return updated counts', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/read-state/calls',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.unseenMissedCalls).toBe(0);
      expect(body.unreadMessages).toBe(5);
      expect(mockReadStateService.markMissedCallsAsViewed).toHaveBeenCalledWith('test-device-id');
    });
  });

  describe('POST /api/read-state/messages/:number', () => {
    it('should mark a thread as read and return updated counts', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/read-state/messages/+15551234567?from=%2B15550000000',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.unreadMessages).toBe(3);
      expect(body.unseenMissedCalls).toBe(2);
      expect(mockReadStateService.markThreadAsRead).toHaveBeenCalledWith(
        '+15550000000',
        '+15551234567',
        'test-device-id'
      );
    });

    it('should return 400 when the from (provider number) query param is missing', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/read-state/messages/+15551234567',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for empty phone number', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/read-state/messages/ ',
      });

      // The route parameter will be a space, which should be trimmed and rejected
      // Actually Fastify decodes this as ' ' which trims to empty
      expect(response.statusCode).toBe(400);
    });
  });
});
