import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerProviderRoutes } from './provider-routes.js';
import type { ProviderRegistry, ProviderRegistryEntry } from '../services/provider-registry.js';

/**
 * Regression test: the list (`GET /api/providers`) and detail
 * (`GET /api/providers/:id`) endpoints must report the SAME status for a
 * provider. Previously the detail endpoint omitted `status` entirely, so the
 * UI always rendered "Error" in the detail view while the list showed the real
 * status (e.g. OK for a healthy cloud provider).
 */

const VONAGE_ID = '11111111-1111-1111-1111-111111111111';
const ELKS_ID = '22222222-2222-2222-2222-222222222222';
const DISABLED_ID = '33333333-3333-3333-3333-333333333333';
const UNAVAILABLE_ID = '44444444-4444-4444-4444-444444444444';

function entry(overrides: Partial<ProviderRegistryEntry>): ProviderRegistryEntry {
  return {
    id: 'id',
    type: 'vonage',
    displayName: 'Provider',
    config: {},
    enabled: true,
    instance: {} as ProviderRegistryEntry['instance'],
    status: 'active',
    ...overrides,
  };
}

function createMockRegistry(entries: ProviderRegistryEntry[]): ProviderRegistry {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    listProviders: vi.fn(() => entries),
    getProvider: vi.fn((id: string) => byId.get(id)),
    getWebhookUrls: vi.fn(() => []),
    getAudioWsUrl: vi.fn(() => 'wss://example.com/audio/'),
  } as unknown as ProviderRegistry;
}

describe('provider-routes status parity', () => {
  let server: FastifyInstance;

  const entries: ProviderRegistryEntry[] = [
    entry({ id: VONAGE_ID, type: 'vonage', displayName: 'Vonage', status: 'active', enabled: true }),
    entry({ id: ELKS_ID, type: '46elks', displayName: '46elks', status: 'active', enabled: true }),
    entry({ id: DISABLED_ID, type: 'vonage', displayName: 'Disabled', status: 'disabled', enabled: false }),
    entry({ id: UNAVAILABLE_ID, type: 'vonage', displayName: 'Broken', status: 'unavailable', enabled: true }),
  ];

  beforeEach(async () => {
    server = Fastify({ logger: false });
    registerProviderRoutes(server, createMockRegistry(entries));
    await server.ready();
  });

  async function listStatuses(): Promise<Record<string, string>> {
    const res = await server.inject({ method: 'GET', url: '/api/providers' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { providers: Array<{ id: string; status: string }> };
    return Object.fromEntries(body.providers.map((p) => [p.id, p.status]));
  }

  async function detailStatus(id: string): Promise<string> {
    const res = await server.inject({ method: 'GET', url: `/api/providers/${id}` });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.payload) as { status: string }).status;
  }

  it('reports the same status in list and detail for every provider', async () => {
    const list = await listStatuses();
    for (const id of [VONAGE_ID, ELKS_ID, DISABLED_ID, UNAVAILABLE_ID]) {
      expect(await detailStatus(id)).toBe(list[id]);
    }
  });

  it('reports OK for a healthy, active cloud provider (not Error)', async () => {
    expect(await detailStatus(VONAGE_ID)).toBe('ok');
    expect(await detailStatus(ELKS_ID)).toBe('ok');
  });

  it('reports disabled and error correctly in the detail view', async () => {
    expect(await detailStatus(DISABLED_ID)).toBe('disabled');
    expect(await detailStatus(UNAVAILABLE_ID)).toBe('error');
  });
});

describe('provider-routes health-driven status', () => {
  const HEALTHY_ID = '55555555-5555-5555-5555-555555555555';
  const UNHEALTHY_ID = '66666666-6666-6666-6666-666666666666';

  const entries: ProviderRegistryEntry[] = [
    entry({ id: HEALTHY_ID, type: 'vonage', displayName: 'Healthy', status: 'active', enabled: true, health: { healthy: true, reason: null } }),
    entry({ id: UNHEALTHY_ID, type: '46elks', displayName: 'Unhealthy', status: 'active', enabled: true, health: { healthy: false, reason: 'Authentication failed (401)', authFailure: true } }),
  ];

  let server: FastifyInstance;

  beforeEach(async () => {
    server = Fastify({ logger: false });
    registerProviderRoutes(server, createMockRegistry(entries));
    await server.ready();
  });

  it('marks an active provider with a failed health check as error', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/providers' });
    const body = JSON.parse(res.payload) as { providers: Array<{ id: string; status: string }> };
    const byId = Object.fromEntries(body.providers.map((p) => [p.id, p.status]));
    expect(byId[HEALTHY_ID]).toBe('ok');
    expect(byId[UNHEALTHY_ID]).toBe('error');
  });

  it('surfaces the health reason and authError in the detail view for an unhealthy provider', async () => {
    const res = await server.inject({ method: 'GET', url: `/api/providers/${UNHEALTHY_ID}` });
    const body = JSON.parse(res.payload) as { status: string; healthReason: string | null; authError: boolean };
    expect(body.status).toBe('error');
    expect(body.healthReason).toBe('Authentication failed (401)');
    expect(body.authError).toBe(true);
  });

  it('returns a null health reason and no authError for a healthy provider', async () => {
    const res = await server.inject({ method: 'GET', url: `/api/providers/${HEALTHY_ID}` });
    const body = JSON.parse(res.payload) as { status: string; healthReason: string | null; authError: boolean };
    expect(body.status).toBe('ok');
    expect(body.healthReason).toBeNull();
    expect(body.authError).toBe(false);
  });

  it('includes healthReason and authError in the list response too', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/providers' });
    const body = JSON.parse(res.payload) as {
      providers: Array<{ id: string; healthReason: string | null; authError: boolean }>;
    };
    const unhealthy = body.providers.find((p) => p.id === UNHEALTHY_ID)!;
    expect(unhealthy.healthReason).toBe('Authentication failed (401)');
    expect(unhealthy.authError).toBe(true);
  });
});
