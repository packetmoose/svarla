import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerNumberRoutes } from './number-routes.js';
import type { NumberManagementService, NumberRecord, SyncResult } from '../services/number-management-service.js';

function createMockNumberService() {
  return {
    getNumbers: vi.fn<[], Promise<NumberRecord[]>>(),
    getAllNumbers: vi.fn<[], Promise<NumberRecord[]>>(),
    getDefaultNumber: vi.fn<[], Promise<NumberRecord | null>>(),
    updateLabel: vi.fn<[string, string], Promise<{ success: boolean; error?: string }>>(),
    syncNumbers: vi.fn<[string], Promise<SyncResult>>(),
    setActive: vi.fn<[string, boolean], Promise<{ success: boolean; error?: string }>>(),
    markNumberUsed: vi.fn<[string], Promise<boolean>>(),
  } as unknown as NumberManagementService;
}

describe('Number Routes', () => {
  let server: FastifyInstance;
  let mockService: ReturnType<typeof createMockNumberService>;

  beforeEach(async () => {
    server = Fastify({ logger: false });
    mockService = createMockNumberService();
    registerNumberRoutes(server, mockService as unknown as NumberManagementService);
    await server.ready();
  });

  describe('GET /api/numbers', () => {
    it('should return list of numbers with labels', async () => {
      const now = new Date();
      (mockService.getAllNumbers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { number: '+14155551234', provider_id: 'p1', provider_display_name: 'Vonage', label: 'Personal', added_at: now, is_active: true, last_used_at: now },
        { number: '+14155555678', provider_id: 'p1', provider_display_name: 'Vonage', label: null, added_at: now, is_active: true, last_used_at: null },
      ]);
      (mockService.getDefaultNumber as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: '+14155551234',
        provider_id: 'p1',
        provider_display_name: 'Vonage',
        label: 'Personal',
        added_at: now,
        is_active: true,
        last_used_at: now,
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api/numbers',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.numbers).toHaveLength(2);
      expect(body.numbers[0].number).toBe('+14155551234');
      expect(body.numbers[0].label).toBe('Personal');
      expect(body.numbers[0].providerId).toBe('p1');
      expect(body.numbers[0].providerDisplayName).toBe('Vonage');
      expect(body.numbers[1].label).toBeNull();
      expect(body.defaultNumber).toBe('+14155551234');
    });

    it('should return empty list when no numbers exist', async () => {
      (mockService.getAllNumbers as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (mockService.getDefaultNumber as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const response = await server.inject({
        method: 'GET',
        url: '/api/numbers',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.numbers).toEqual([]);
      expect(body.defaultNumber).toBeNull();
    });
  });

  describe('PUT /api/numbers/:number/label', () => {
    it('should update label successfully', async () => {
      (mockService.updateLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });

      const response = await server.inject({
        method: 'PUT',
        url: '/api/numbers/+14155551234/label',
        payload: { label: 'Business' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe('Label updated successfully');
      expect(body.number).toBe('+14155551234');
      expect(body.label).toBe('Business');
    });

    it('should return 400 for missing label', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: '/api/numbers/+14155551234/label',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 for empty label', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: '/api/numbers/+14155551234/label',
        payload: { label: '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for label exceeding 30 characters', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: '/api/numbers/+14155551234/label',
        payload: { label: 'A'.repeat(31) },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 404 when number not found', async () => {
      (mockService.updateLabel as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Number not found or inactive',
      });

      const response = await server.inject({
        method: 'PUT',
        url: '/api/numbers/+19999999999/label',
        payload: { label: 'Test' },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Number not found or inactive');
    });
  });

  describe('POST /api/numbers/sync', () => {
    it('should return sync results', async () => {
      (mockService.syncNumbers as ReturnType<typeof vi.fn>).mockResolvedValue({
        added: ['+14155559999'],
        removed: ['+14155550000'],
        total: 3,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/numbers/sync',
        payload: { providerId: 'provider-1' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe('Sync completed');
      expect(body.added).toEqual(['+14155559999']);
      expect(body.removed).toEqual(['+14155550000']);
      expect(body.total).toBe(3);
    });

    it('should return empty changes when nothing changed', async () => {
      (mockService.syncNumbers as ReturnType<typeof vi.fn>).mockResolvedValue({
        added: [],
        removed: [],
        total: 2,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/numbers/sync',
        payload: { providerId: 'provider-1' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.added).toEqual([]);
      expect(body.removed).toEqual([]);
      expect(body.total).toBe(2);
    });

    it('should return 400 when providerId is missing', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/numbers/sync',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('providerId is required');
    });
  });
});
