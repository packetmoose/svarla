import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import { ProviderRegistry } from './provider-registry.js';
import type { ProviderRegistryEntry } from './provider-registry.js';
import type { TelephonyProvider } from '../providers/telephony-provider.js';

/**
 * Tests for ProviderRegistry.onProviderActivated — the mechanism that lets the
 * server wire up runtime handlers (e.g. the modem-gateway signaling WebSocket
 * handler) for providers created or reinitialized AFTER startup, without a
 * server restart.
 */

/** A no-op logger that satisfies the ProviderLogger interface. */
function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Minimal chainable Kysely mock. Every builder method returns the same chain
 * object, and terminal calls (execute / executeTakeFirst) resolve to the rows
 * configured for the current table.
 */
function createMockDb(rowsByTable: Record<string, unknown[]> = {}) {
  const chain: Record<string, unknown> = {};
  const passthrough = [
    'selectFrom', 'select', 'selectAll', 'where', 'set',
    'insertInto', 'values', 'updateTable', 'deleteFrom',
    'returning', 'returningAll', 'orderBy', 'limit', 'offset',
  ];

  let currentTable = '';
  for (const method of passthrough) {
    chain[method] = vi.fn((arg?: unknown) => {
      if ((method === 'selectFrom' || method === 'insertInto' || method === 'updateTable' || method === 'deleteFrom') && typeof arg === 'string') {
        currentTable = arg;
      }
      return chain;
    });
  }
  chain.execute = vi.fn(async () => rowsByTable[currentTable] ?? []);
  chain.executeTakeFirst = vi.fn(async () => (rowsByTable[currentTable] ?? [])[0] ?? undefined);

  return chain as unknown as Kysely<Database>;
}

/** Build a fake TelephonyProvider whose start() resolves. */
function createFakeProvider(overrides: Partial<TelephonyProvider> = {}): TelephonyProvider {
  return {
    providerId: 'dummy',
    makeCall: vi.fn(),
    endCall: vi.fn(),
    answerCall: vi.fn(),
    sendSms: vi.fn(),
    listNumbers: vi.fn(async () => []),
    onEvent: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getWebhookEndpoints: vi.fn(() => []),
    handleWebhook: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as TelephonyProvider;
}

describe('ProviderRegistry.onProviderActivated', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('fires the listener when a new provider is added and initialized', async () => {
    const db = createMockDb();
    const factory = vi.fn(() => createFakeProvider());
    const registry = new ProviderRegistry(db, 'https://example.com', logger, factory);

    const activated: ProviderRegistryEntry[] = [];
    registry.onProviderActivated((entry) => activated.push(entry));

    const { providerId } = await registry.addProvider('dummy', 'My Dummy', {});

    expect(activated).toHaveLength(1);
    expect(activated[0].id).toBe(providerId);
    expect(activated[0].type).toBe('dummy');
    expect(activated[0].status).toBe('active');
    expect(activated[0].instance).not.toBeNull();
  });

  it('does NOT fire the listener when the provider fails to initialize', async () => {
    const db = createMockDb();
    const factory = vi.fn(() =>
      createFakeProvider({ start: vi.fn(async () => { throw new Error('boom'); }) }),
    );
    const registry = new ProviderRegistry(db, 'https://example.com', logger, factory);

    const activated: ProviderRegistryEntry[] = [];
    registry.onProviderActivated((entry) => activated.push(entry));

    await registry.addProvider('dummy', 'Broken', {});

    expect(activated).toHaveLength(0);
  });

  it('fires the listener again when a provider is reinitialized via updateProvider', async () => {
    const providerId = '11111111-1111-1111-1111-111111111111';
    const db = createMockDb({
      // loadAll reads one enabled provider from the "providers" table
      providers: [
        { id: providerId, type: 'dummy', display_name: 'Dummy', config: {}, enabled: true },
      ],
    });
    const factory = vi.fn(() => createFakeProvider());
    const registry = new ProviderRegistry(db, 'https://example.com', logger, factory);

    // loadAll does NOT fire the activation listener (startup wiring is driven by
    // the caller iterating listProviders), so subscribe after loadAll.
    await registry.loadAll();

    const activated: ProviderRegistryEntry[] = [];
    registry.onProviderActivated((entry) => activated.push(entry));

    // A config change reinitializes the instance -> should fire the listener.
    await registry.updateProvider(providerId, { config: { name: 'renamed' } });

    expect(activated).toHaveLength(1);
    expect(activated[0].id).toBe(providerId);
    expect(activated[0].status).toBe('active');
  });

  it('does NOT fire the listener when a provider is disabled via updateProvider', async () => {
    const providerId = '22222222-2222-2222-2222-222222222222';
    const db = createMockDb({
      providers: [
        { id: providerId, type: 'dummy', display_name: 'Dummy', config: {}, enabled: true },
      ],
    });
    const factory = vi.fn(() => createFakeProvider());
    const registry = new ProviderRegistry(db, 'https://example.com', logger, factory);
    await registry.loadAll();

    const activated: ProviderRegistryEntry[] = [];
    registry.onProviderActivated((entry) => activated.push(entry));

    await registry.updateProvider(providerId, { enabled: false });

    expect(activated).toHaveLength(0);
    expect(registry.getProvider(providerId)?.status).toBe('disabled');
  });

  it('builds a full wss:// signaling URL from an https base URL', () => {
    const db = createMockDb();
    const registry = new ProviderRegistry(db, 'https://example.com', logger, vi.fn());
    expect(registry.getSignalingWsUrl('abc')).toBe('wss://example.com/ws/providers/abc/signaling');
  });

  it('builds a full ws:// signaling URL from an http base URL and strips trailing slash', () => {
    const db = createMockDb();
    const registry = new ProviderRegistry(db, 'http://localhost:3000/', logger, vi.fn());
    expect(registry.getSignalingWsUrl('abc')).toBe('ws://localhost:3000/ws/providers/abc/signaling');
  });

  it('falls back to a relative path when no base URL is configured', () => {
    const db = createMockDb();
    const registry = new ProviderRegistry(db, '', logger, vi.fn());
    expect(registry.getSignalingWsUrl('abc')).toBe('/ws/providers/abc/signaling');
  });

  it('builds a wss:// audio URL from an https base URL', () => {
    const db = createMockDb();
    const registry = new ProviderRegistry(db, 'https://example.com', logger, vi.fn());
    expect(registry.getAudioWsUrl()).toBe('wss://example.com/audio/');
  });

  it('builds a ws:// audio URL from an http base URL and strips trailing slash', () => {
    const db = createMockDb();
    const registry = new ProviderRegistry(db, 'http://localhost:3000/', logger, vi.fn());
    expect(registry.getAudioWsUrl()).toBe('ws://localhost:3000/audio/');
  });

  it('returns an empty audio URL when no base URL is configured', () => {
    const db = createMockDb();
    const registry = new ProviderRegistry(db, '', logger, vi.fn());
    expect(registry.getAudioWsUrl()).toBe('');
  });

  it('caches health and fires an immediate check when a provider is added', async () => {
    const db = createMockDb();
    const checkHealth = vi.fn(async () => ({ healthy: false, reason: 'bad creds' }));
    const factory = vi.fn(() => createFakeProvider({ checkHealth }));
    const registry = new ProviderRegistry(db, 'https://example.com', logger, factory);

    // addProvider awaits the initial health check, so the result is cached by
    // the time it resolves.
    const { providerId } = await registry.addProvider('dummy', 'My Dummy', {});

    expect(checkHealth).toHaveBeenCalledTimes(1);
    expect(registry.getHealth(providerId)).toEqual({ healthy: false, reason: 'bad creds' });
  });

  it('awaits a fresh health check on updateProvider so the cached result reflects the new config', async () => {
    const providerId = '99999999-9999-9999-9999-999999999999';
    const db = createMockDb({
      providers: [
        { id: providerId, type: 'dummy', display_name: 'Dummy', config: {}, enabled: true },
      ],
    });
    // Healthy on first init, unhealthy after the config change.
    const checkHealth = vi
      .fn()
      .mockResolvedValueOnce({ healthy: true, reason: null })
      .mockResolvedValueOnce({ healthy: false, reason: 'bad creds', authFailure: true });
    const registry = new ProviderRegistry(db, 'https://example.com', logger, vi.fn(() => createFakeProvider({ checkHealth })));

    await registry.loadAll();
    // loadAll does not run health checks; run one to establish the healthy baseline.
    await registry.checkProviderHealth(providerId);
    expect(registry.getHealth(providerId)).toEqual({ healthy: true, reason: null });

    await registry.updateProvider(providerId, { config: { name: 'changed' } });

    // By the time updateProvider resolves, the fresh (unhealthy) result is cached.
    expect(registry.getHealth(providerId)).toEqual({ healthy: false, reason: 'bad creds', authFailure: true });
  });

  it('records an unhealthy result when checkHealth throws', async () => {
    const db = createMockDb();
    const checkHealth = vi.fn(async () => { throw new Error('boom'); });
    const factory = vi.fn(() => createFakeProvider({ checkHealth }));
    const registry = new ProviderRegistry(db, 'https://example.com', logger, factory);

    const { providerId } = await registry.addProvider('dummy', 'My Dummy', {});
    await registry.checkProviderHealth(providerId);

    expect(registry.getHealth(providerId)).toEqual({ healthy: false, reason: 'Health check error' });
  });

  it('leaves health null for providers without checkHealth()', async () => {
    const db = createMockDb();
    const factory = vi.fn(() => createFakeProvider()); // no checkHealth
    const registry = new ProviderRegistry(db, 'https://example.com', logger, factory);

    const { providerId } = await registry.addProvider('dummy', 'My Dummy', {});
    await registry.checkProviderHealth(providerId);

    expect(registry.getHealth(providerId)).toBeNull();
  });

  it('checkAllHealth checks every enabled provider that supports it', async () => {
    const db = createMockDb();
    const checkHealth = vi.fn(async () => ({ healthy: true, reason: null }));
    const factory = vi.fn(() => createFakeProvider({ checkHealth }));
    const registry = new ProviderRegistry(db, 'https://example.com', logger, factory);

    await registry.addProvider('dummy', 'A', {});
    await registry.addProvider('dummy', 'B', {});
    checkHealth.mockClear();

    await registry.checkAllHealth();

    expect(checkHealth).toHaveBeenCalledTimes(2);
  });

  it('checkAllHealth skips providers with an auth failure but keeps retrying transient failures', async () => {
    const db = createMockDb();
    const authFail = vi.fn(async () => ({ healthy: false, reason: 'Authentication failed (401)', authFailure: true }));
    const transientFail = vi.fn(async () => ({ healthy: false, reason: 'API returned 500' }));

    const registryA = new ProviderRegistry(db, 'https://example.com', logger, vi.fn(() => createFakeProvider({ checkHealth: authFail })));
    const { providerId: authId } = await registryA.addProvider('dummy', 'AuthBad', {});
    await registryA.checkProviderHealth(authId); // cache the auth failure
    authFail.mockClear();
    await registryA.checkAllHealth();
    expect(authFail).not.toHaveBeenCalled(); // skipped

    const registryB = new ProviderRegistry(db, 'https://example.com', logger, vi.fn(() => createFakeProvider({ checkHealth: transientFail })));
    const { providerId: transientId } = await registryB.addProvider('dummy', 'Flaky', {});
    await registryB.checkProviderHealth(transientId); // cache the transient failure
    transientFail.mockClear();
    await registryB.checkAllHealth();
    expect(transientFail).toHaveBeenCalledTimes(1); // still retried
  });

  it('isolates listener failures so other listeners still run', async () => {
    const db = createMockDb();
    const factory = vi.fn(() => createFakeProvider());
    const registry = new ProviderRegistry(db, 'https://example.com', logger, factory);

    const good: ProviderRegistryEntry[] = [];
    registry.onProviderActivated(() => { throw new Error('bad listener'); });
    registry.onProviderActivated((entry) => good.push(entry));

    await registry.addProvider('dummy', 'My Dummy', {});

    expect(good).toHaveLength(1);
    expect(logger.error).toHaveBeenCalled();
  });
});
