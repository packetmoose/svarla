import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerWebhookRouter } from './webhook-router.js';
import type { ProviderRegistry, ProviderRegistryEntry } from '../services/provider-registry.js';
import type { CallOrchestrator } from '../services/call-orchestrator.js';
import type { VonageTelephonyProvider } from '../providers/vonage-telephony-provider.js';

/**
 * Tests for the control-plane teardown fix (bug #2): a terminal Vonage call
 * event on the /event webhook must end the corresponding call via the
 * orchestrator, resolving the raw provider UUID to the internal callId.
 */
describe('webhook-router — Vonage /event terminal teardown', () => {
  let server: FastifyInstance;
  let mockOrchestrator: CallOrchestrator;

  const INTERNAL_CALL_ID = 'internal-call-abc';
  const PROVIDER_UUID = 'vonage-uuid-123';

  function makeRegistry(): ProviderRegistry {
    // Minimal Vonage provider instance — handleEvent only uses processCallEvent,
    // which we don't rely on here (the terminal-teardown path runs before it).
    const providerInstance = {
      processCallEvent: vi.fn(),
      getWebhookEndpoints: vi.fn().mockReturnValue(['answer', 'event', 'inbound-sms', 'sms-status']),
    } as unknown as VonageTelephonyProvider;

    const entry: ProviderRegistryEntry = {
      id: 'vonage',
      type: 'vonage',
      displayName: 'Vonage',
      config: {}, // no api_secret/application_id → JWT verification skipped
      enabled: true,
      instance: providerInstance,
      status: 'active',
    } as ProviderRegistryEntry;

    return {
      getProvider: vi.fn().mockReturnValue(entry),
    } as unknown as ProviderRegistry;
  }

  beforeEach(async () => {
    server = Fastify({ logger: false });
    mockOrchestrator = {
      getCallIdByProviderCallId: vi.fn().mockReturnValue(INTERNAL_CALL_ID),
      endCall: vi.fn().mockResolvedValue(undefined),
    } as unknown as CallOrchestrator;

    registerWebhookRouter(server, makeRegistry(), {
      callOrchestrator: mockOrchestrator,
      webhookBaseUrl: 'https://svarla.example',
    });
    await server.ready();
  });

  it('ends the call on a terminal "completed" event (caller hangup)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/vonage/event',
      payload: {
        uuid: PROVIDER_UUID,
        status: 'completed',
        direction: 'inbound',
        from: '+14155551234',
        to: '+14155550000',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockOrchestrator.getCallIdByProviderCallId).toHaveBeenCalledWith(PROVIDER_UUID);
    expect(mockOrchestrator.endCall).toHaveBeenCalledWith(
      INTERNAL_CALL_ID,
      'provider_call_state_changed',
    );
  });

  it('does NOT end the call on a non-terminal "answered" event', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/vonage/event',
      payload: {
        uuid: PROVIDER_UUID,
        status: 'answered',
        direction: 'inbound',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockOrchestrator.endCall).not.toHaveBeenCalled();
  });

  it('does not end a call for an internal SDK leg (to starts with "device-")', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/vonage/event',
      payload: {
        uuid: PROVIDER_UUID,
        status: 'completed',
        direction: 'inbound',
        to: 'device-xyz',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockOrchestrator.endCall).not.toHaveBeenCalled();
  });

  it('does not end a call when the provider UUID is unknown to the orchestrator', async () => {
    (mockOrchestrator.getCallIdByProviderCallId as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/vonage/event',
      payload: {
        uuid: 'unknown-uuid',
        status: 'completed',
        direction: 'inbound',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockOrchestrator.endCall).not.toHaveBeenCalled();
  });
});

/**
 * Regression tests for issue #31: unknown webhook endpoints must NOT return 2xx
 * (they previously fell through to a silent HTTP 200), and cross-provider
 * endpoint aliases must route to the correct handler.
 */
describe('webhook-router — endpoint validation & aliasing (issue #31)', () => {
  interface HarnessOptions {
    type?: string;
    endpoints?: string[];
    conversationService?: unknown;
  }

  async function makeServer(opts: HarnessOptions = {}): Promise<{
    server: FastifyInstance;
    handleWebhook: ReturnType<typeof vi.fn>;
  }> {
    const handleWebhook = vi.fn().mockResolvedValue({});
    const providerInstance = {
      processCallEvent: vi.fn(),
      processSmsEvent: vi.fn(),
      getWebhookEndpoints: vi
        .fn()
        .mockReturnValue(opts.endpoints ?? ['answer', 'event', 'inbound-sms', 'sms-status']),
      handleWebhook,
    } as unknown as VonageTelephonyProvider;

    const entry: ProviderRegistryEntry = {
      id: 'prov',
      type: opts.type ?? 'vonage',
      displayName: 'Test Provider',
      // Disable webhook validation so tests exercise endpoint resolution rather
      // than the provider-specific auth (Vonage JWT / 46elks IP allowlist).
      config: { webhook_validation: false },
      enabled: true,
      instance: providerInstance,
      status: 'active',
    } as ProviderRegistryEntry;

    const registry = {
      getProvider: vi.fn().mockReturnValue(entry),
    } as unknown as ProviderRegistry;

    const server = Fastify({ logger: false });
    registerWebhookRouter(server, registry, {
      conversationService: opts.conversationService as never,
    });
    await server.ready();
    return { server, handleWebhook };
  }

  it('returns 404 (never 2xx) for an unknown endpoint on a Vonage provider', async () => {
    const { server } = await makeServer();
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/prov/sms_incoming_typo',
      payload: { from: '+1', to: '+2', text: 'hi' },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error).toBe('Webhook endpoint not found');
    expect(body.endpoint).toBe('sms_incoming_typo');
    await server.close();
  });

  it('routes 46elks alias sms_incoming to the Vonage inbound-sms handler', async () => {
    const receiveMessage = vi.fn().mockResolvedValue(undefined);
    const { server } = await makeServer({
      conversationService: { receiveMessage },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/prov/sms_incoming',
      payload: {
        message_uuid: 'msg-1',
        from: '+14155551234',
        to: '+14155550000',
        text: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(receiveMessage).toHaveBeenCalledWith(
      'msg-1',
      '+14155551234',
      '+14155550000',
      'hello',
      expect.any(Date),
    );
    await server.close();
  });

  it('accepts the native inbound-sms endpoint unchanged', async () => {
    const receiveMessage = vi.fn().mockResolvedValue(undefined);
    const { server } = await makeServer({
      conversationService: { receiveMessage },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/prov/inbound-sms',
      payload: {
        message_uuid: 'msg-2',
        from: '+14155551234',
        to: '+14155550000',
        text: 'hi again',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(receiveMessage).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it('accepts 46elks voice_event alias (voice-event) via the generic handler', async () => {
    const { server, handleWebhook } = await makeServer({
      type: '46elks',
      endpoints: ['voice_start', 'sms_incoming'],
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/prov/voice-event',
      payload: { callid: 'c-1', status: 'success' },
    });

    expect(response.statusCode).toBe(200);
    // Resolved to the provider's native suffix before delegating.
    expect(handleWebhook).toHaveBeenCalledWith('voice_event', expect.anything(), expect.anything());
    await server.close();
  });
});
