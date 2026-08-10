import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerNumberRoutes } from './number-routes.js';
import type { NumberManagementService, NumberRecord } from '../services/number-management-service.js';

/**
 * Multi-Provider Number Routes Verification Tests
 *
 * Validates Requirements 8.1, 8.4:
 * - The numbers API returns a combined list from ProviderRegistry across all providers
 * - The response format is unified — the Android client does not need to branch
 *   based on provider type to display numbers
 */

function createMockNumberService() {
  return {
    getNumbers: vi.fn<[], Promise<NumberRecord[]>>(),
    getAllNumbers: vi.fn<[], Promise<NumberRecord[]>>(),
    getDefaultNumber: vi.fn<[], Promise<NumberRecord | null>>(),
    updateLabel: vi.fn<[string, string], Promise<{ success: boolean; error?: string }>>(),
    syncNumbers: vi.fn<[string], Promise<{ added: string[]; removed: string[]; total: number }>>(),
    setActive: vi.fn<[string, boolean], Promise<{ success: boolean; error?: string }>>(),
    markNumberUsed: vi.fn<[string], Promise<boolean>>(),
    setDefaultNumber: vi.fn<[string | null], Promise<{ success: boolean; error?: string }>>(),
    setBlockInboundCalls: vi.fn<[string, boolean], Promise<{ success: boolean; error?: string }>>(),
  } as unknown as NumberManagementService;
}

describe('Multi-Provider Number Routes - Unified List Verification', () => {
  let server: FastifyInstance;
  let mockService: ReturnType<typeof createMockNumberService>;

  const now = new Date();

  const multiProviderNumbers: NumberRecord[] = [
    {
      number: '+14155551111',
      provider_id: 'vonage-provider-1',
      provider_display_name: 'Vonage',
      label: 'US Office',
      color: '#6750A4',
      added_at: new Date('2024-01-01'),
      is_active: true,
      last_used_at: new Date('2024-06-01'),
      block_inbound_calls: false,
    },
    {
      number: '+14155552222',
      provider_id: 'vonage-provider-1',
      provider_display_name: 'Vonage',
      label: null,
      color: '#006B5F',
      added_at: new Date('2024-01-02'),
      is_active: true,
      last_used_at: null,
      block_inbound_calls: false,
    },
    {
      number: '+46701234567',
      provider_id: '46elks-provider-1',
      provider_display_name: '46elks',
      label: 'Swedish Mobile',
      color: '#B5485E',
      added_at: new Date('2024-02-01'),
      is_active: true,
      last_used_at: new Date('2024-06-15'),
      block_inbound_calls: false,
    },
    {
      number: '+46812345678',
      provider_id: '46elks-provider-1',
      provider_display_name: '46elks',
      label: 'Stockholm',
      color: '#526E2D',
      added_at: new Date('2024-02-02'),
      is_active: true,
      last_used_at: new Date('2024-05-01'),
      block_inbound_calls: true,
    },
  ];

  beforeEach(async () => {
    server = Fastify({ logger: false });
    mockService = createMockNumberService();
    registerNumberRoutes(server, mockService as unknown as NumberManagementService);
    await server.ready();
  });

  describe('GET /api/numbers - combined multi-provider response', () => {
    it('should return numbers from multiple providers in a single flat array', async () => {
      (mockService.getAllNumbers as ReturnType<typeof vi.fn>).mockResolvedValue(multiProviderNumbers);
      (mockService.getDefaultNumber as ReturnType<typeof vi.fn>).mockResolvedValue(multiProviderNumbers[2]);

      const response = await server.inject({
        method: 'GET',
        url: '/api/numbers',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      // All 4 numbers from both providers in a single array
      expect(body.numbers).toHaveLength(4);

      // Numbers from different providers are mixed in the same array
      const providerIds = new Set(body.numbers.map((n: any) => n.providerId));
      expect(providerIds.size).toBe(2);
      expect(providerIds.has('vonage-provider-1')).toBe(true);
      expect(providerIds.has('46elks-provider-1')).toBe(true);
    });

    it('should use identical field structure for numbers from all providers', async () => {
      (mockService.getAllNumbers as ReturnType<typeof vi.fn>).mockResolvedValue(multiProviderNumbers);
      (mockService.getDefaultNumber as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const response = await server.inject({
        method: 'GET',
        url: '/api/numbers',
      });

      const body = JSON.parse(response.payload);
      const expectedFields = ['number', 'label', 'color', 'addedAt', 'isActive', 'lastUsedAt', 'providerId', 'providerDisplayName', 'blockInboundCalls'];

      body.numbers.forEach((num: any) => {
        expectedFields.forEach((field) => {
          expect(num).toHaveProperty(field);
        });
        // No provider-specific fields leaked
        expect(num).not.toHaveProperty('vonageNumber');
        expect(num).not.toHaveProperty('vonageUser');
        expect(num).not.toHaveProperty('elksId');
      });
    });

    it('should set defaultNumber from any provider without provider bias', async () => {
      // Default is a 46elks number
      (mockService.getAllNumbers as ReturnType<typeof vi.fn>).mockResolvedValue(multiProviderNumbers);
      (mockService.getDefaultNumber as ReturnType<typeof vi.fn>).mockResolvedValue(multiProviderNumbers[2]);

      const response = await server.inject({
        method: 'GET',
        url: '/api/numbers',
      });

      const body = JSON.parse(response.payload);
      expect(body.defaultNumber).toBe('+46701234567');
    });

    it('should include providerDisplayName for informational display without requiring provider selection', async () => {
      (mockService.getAllNumbers as ReturnType<typeof vi.fn>).mockResolvedValue(multiProviderNumbers);
      (mockService.getDefaultNumber as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const response = await server.inject({
        method: 'GET',
        url: '/api/numbers',
      });

      const body = JSON.parse(response.payload);

      // Provider name is included for optional display (e.g., settings screen)
      // but is NOT required for the client to make calls or send SMS
      const vonageNum = body.numbers.find((n: any) => n.number === '+14155551111');
      expect(vonageNum.providerDisplayName).toBe('Vonage');

      const elksNum = body.numbers.find((n: any) => n.number === '+46701234567');
      expect(elksNum.providerDisplayName).toBe('46elks');
    });

    it('should handle the case where one provider has no numbers', async () => {
      // Only 46elks numbers
      const elksOnly = multiProviderNumbers.filter((n) => n.provider_id === '46elks-provider-1');
      (mockService.getAllNumbers as ReturnType<typeof vi.fn>).mockResolvedValue(elksOnly);
      (mockService.getDefaultNumber as ReturnType<typeof vi.fn>).mockResolvedValue(elksOnly[0]);

      const response = await server.inject({
        method: 'GET',
        url: '/api/numbers',
      });

      const body = JSON.parse(response.payload);
      expect(body.numbers).toHaveLength(2);
      expect(body.numbers.every((n: any) => n.providerId === '46elks-provider-1')).toBe(true);
    });

    it('should support label updates on numbers from any provider equally', async () => {
      (mockService.updateLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });

      // Update label on Vonage number
      const vonageResponse = await server.inject({
        method: 'PUT',
        url: '/api/numbers/+14155551111/label',
        payload: { label: 'New Vonage Label' },
      });
      expect(vonageResponse.statusCode).toBe(200);

      // Update label on 46elks number — same API, same behavior
      const elksResponse = await server.inject({
        method: 'PUT',
        url: '/api/numbers/+46701234567/label',
        payload: { label: 'New Elks Label' },
      });
      expect(elksResponse.statusCode).toBe(200);
    });
  });
});
