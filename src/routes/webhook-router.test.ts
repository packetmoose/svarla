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
