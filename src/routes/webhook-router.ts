import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ProviderRegistry } from '../services/provider-registry.js';
import type { CallHistoryService } from '../services/call-history-service.js';
import type { ConversationService } from '../services/conversation-service.js';
import type { WakeSignalPublisher } from '../notifications/wake-signal-publisher.js';
import type { DeviceRegistryManager } from '../services/device-registry-manager.js';
import type { VonageTelephonyProvider } from '../providers/vonage-telephony-provider.js';
import type { Elks46TelephonyProvider } from '../providers/elks46-telephony-provider.js';
import type { NumberManagementService } from '../services/number-management-service.js';
import type { WebSocketBroadcaster } from '../websocket/broadcaster.js';
import type { CallOrchestrator } from '../services/call-orchestrator.js';
import type { NotificationService } from '../services/notification-service.js';
import { verifyVonageWebhookJwt } from '../middleware/webhook-auth-middleware.js';
import { buildOutboundCallNcco } from '../providers/ncco-builder.js';
import type { NccoAction } from '../providers/ncco-builder.js';

/**
 * Logger interface compatible with Fastify/Pino logger.
 */
interface WebhookRouterLogger {
  warn(msg: string): void;
  warn(obj: unknown, msg: string): void;
  error(msg: string): void;
  error(obj: unknown, msg: string): void;
  info(msg: string): void;
  info(obj: unknown, msg: string): void;
}

/**
 * Service dependencies for the webhook router.
 * These enable the router to perform application-level logic
 * (push notifications, call history, SMS processing) that mirrors
 * the legacy webhook routes.
 */
export interface WebhookRouterServices {
  callHistoryService?: CallHistoryService;
  conversationService?: ConversationService;
  wakeSignalPublisher?: WakeSignalPublisher;
  deviceRegistryManager?: DeviceRegistryManager;
  numberManagementService?: NumberManagementService;
  wsBroadcaster?: WebSocketBroadcaster;
  callOrchestrator?: CallOrchestrator;
  notificationService?: NotificationService;
  webhookBaseUrl?: string;
}

/**
 * Checks if a caller ID value represents a dialable phone number.
 * Returns false for anonymous/restricted/withheld callers and empty strings.
 */
function isDialableNumber(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('+')) return true;
  return /^\d+$/.test(value);
}

/**
 * Normalizes an inbound number from Vonage for storage.
 * - Already E.164 (starts with +): returns as-is
 * - Non-numeric string (custom sender name like "MyBrand"): returns as-is
 * - Short code (all digits, does not start with 0, ≤6 digits): returns as-is
 * - Full international number (all digits, 7+ digits): prepends +
 * - Local number (starts with 0): prepends + (will need country code normalization later)
 */
function normalizeInboundNumber(value: string): string {
  if (!value) return value;
  if (value.startsWith('+')) return value;
  // Non-numeric: custom sender name — return as-is
  if (!/^\d+$/.test(value)) return value;
  // Short code: digits only, doesn't start with 0, 6 or fewer digits
  if (!value.startsWith('0') && value.length <= 6) return value;
  // Full number: prepend +
  return `+${value}`;
}

/**
 * Register dynamic provider-scoped webhook routes.
 *
 * Implements the route pattern `/webhooks/:providerId/*` which:
 * 1. Extracts the providerId param and the remaining endpoint path
 * 2. Looks up the provider in ProviderRegistry
 * 3. If not found → 404 + warning log
 * 4. If disabled → 503 + warning log
 * 5. If active → handles the webhook with full application-level logic
 *
 * No session authentication is required for webhook routes.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */
export function registerWebhookRouter(
  server: FastifyInstance,
  registry: ProviderRegistry,
  services?: WebhookRouterServices,
  logger?: WebhookRouterLogger,
): void {
  const log = logger ?? server.log;
  const {
    callHistoryService,
    conversationService,
    wakeSignalPublisher,
    deviceRegistryManager,
    numberManagementService,
    wsBroadcaster,
    callOrchestrator,
    notificationService,
    webhookBaseUrl,
  } = services ?? {};

  /**
   * Helper: record a blocked call in call history, send push notifications,
   * and broadcast a WebSocket event.
   */
  async function recordBlockedCallAndNotify(fromNumber: string, toNumber: string, callId: string): Promise<void> {
    // Record in call history
    let recorded = false;
    if (callHistoryService) {
      try {
        // Use a placeholder for unknown callers
        const callerNumber = fromNumber || 'Unknown';
        await callHistoryService.recordCall({
          phone_number: callerNumber,
          provider_number: toNumber,
          call_type: 'BLOCKED',
          provider_call_id: callId,
        });
        recorded = true;
        server.log.info(`[BlockedCall] Recorded: from=${callerNumber} to=${toNumber} id=${callId}`);
      } catch (err) {
        server.log.error(err, `[BlockedCall] FAILED to record: from=${fromNumber} to=${toNumber} id=${callId}`);
      }
    } else {
      server.log.warn(`[BlockedCall] callHistoryService not available, cannot record blocked call`);
    }

    // If recording succeeded, callHistoryService already broadcast a call_history_update event.
    // If it failed (e.g. constraint violation), broadcast manually so the app can still show it.
    if (!recorded && wsBroadcaster) {
      wsBroadcaster.broadcast({
        type: 'call_history_update' as const,
        data: {
          id: callId,
          phone_number: fromNumber || 'Unknown',
          provider_number: toNumber,
          call_type: 'BLOCKED',
          timestamp: new Date().toISOString(),
          duration_seconds: null,
          provider_call_id: callId,
          answered_by_device: null,
        },
      });
      server.log.info(`[BlockedCall] Broadcast manual call_history_update for ${callId} (DB record failed)`);
    }

    // Send push notification to devices
    if (wakeSignalPublisher && deviceRegistryManager) {
      try {
        const devices = await deviceRegistryManager.getActiveDevicesWithPushInfo();
        server.log.info(`[BlockedCall] Sending wake signal to ${devices.length} device(s)`);
        if (devices.length > 0) {
          await wakeSignalPublisher.sendToAllDevices(devices, {
            id: callId,
            priority: 'normal',
          }, 'blocked_call');
        }
      } catch (err) {
        server.log.error(err, '[BlockedCall] Failed to send wake signals');
      }
    } else {
      server.log.warn(`[BlockedCall] wakeSignalPublisher or deviceRegistryManager not available`);
    }

    // Broadcast blocked_call WebSocket event (for any app-specific handling)
    if (wsBroadcaster) {
      wsBroadcaster.broadcast({
        type: 'blocked_call' as const,
        data: {
          callId,
          from: fromNumber || 'Unknown',
          providerNumber: toNumber,
        },
      });
    }
  }

  // Register a wildcard route that captures providerId and any remaining path
  server.all('/webhooks/:providerId/*', {
    config: {
      rateLimit: {
        max: 200,
        timeWindow: '1 minute',
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { providerId: string; '*': string };
    const providerId = params.providerId;
    const endpoint = params['*'];

    // Look up provider in registry
    const entry = registry.getProvider(providerId);

    if (!entry) {
      log.warn(`Webhook received for unknown provider: ${providerId}`);
      return reply.status(404).send({
        error: 'Provider not found',
        providerId,
      });
    }

    if (entry.status === 'disabled' || !entry.enabled) {
      log.warn(`Webhook received for disabled provider: ${providerId} (${entry.displayName})`);
      return reply.status(503).send({
        error: 'Provider is disabled',
        providerId,
      });
    }

    if (!entry.instance) {
      log.warn(`Webhook received for unavailable provider: ${providerId} (${entry.displayName})`);
      return reply.status(503).send({
        error: 'Provider is unavailable',
        providerId,
      });
    }

    // Per-provider webhook signature verification
    // For Vonage providers, verify the JWT in the Authorization header against
    // the provider's own API secret and application ID from its config.
    if (entry.type === 'vonage') {
      const providerConfig = entry.config as Record<string, string>;
      const apiSecret = providerConfig.api_secret ?? '';
      const applicationId = providerConfig.application_id ?? '';

      if (apiSecret || applicationId) {
        const verified = verifyVonageWebhookJwt(request, {
          vonageApiSecret: apiSecret,
          vonageApplicationId: applicationId,
        });

        if (!verified) {
          // Vonage GET requests (answer webhook) often don't carry a JWT,
          // so only enforce on POST/PUT requests that should be signed.
          if (request.method !== 'GET') {
            log.warn(`Webhook signature verification failed for provider ${providerId}, endpoint: ${endpoint}`);
            return reply.status(401).send({
              error: 'Webhook signature verification failed',
              statusCode: 401,
            });
          }
        }
      }
    }

    // Route to endpoint-specific handlers for Vonage providers
    // to replicate full legacy webhook behavior
    if (entry.type === 'vonage') {
      const provider = entry.instance as VonageTelephonyProvider;
      switch (endpoint) {
        case 'answer':
          return handleAnswer(request, reply, provider, log);
        case 'event':
          return handleEvent(request, reply, provider, log);
        case 'inbound-sms':
          return handleInboundSms(request, reply, provider, log);
        case 'sms-status':
          return handleSmsStatus(request, reply, provider);
        default:
          break;
      }
    }

    // Handle 46elks voice_start webhook with CallOrchestrator integration
    // For inbound calls, we need to create a MediaBridge session and return the WebSocket number
    // so 46elks routes audio via the Realtime Voice API.
    if (entry.type === '46elks' && endpoint === 'voice_start' && callOrchestrator) {
      const body = request.body as Record<string, unknown>;
      const direction = body.direction as string ?? '';
      const callId = body.callid as string ?? '';
      const from = body.from as string ?? '';
      const to = body.to as string ?? '';

      if (direction === 'incoming') {
        try {
          const normalizedFrom = from
            ? (from.startsWith('+') ? from : (isDialableNumber(from) ? `+${from}` : from))
            : 'anonymous';
          const normalizedTo = to.startsWith('+') ? to : `+${to}`;
          const result = await callOrchestrator.handleInbound(providerId, callId, normalizedFrom, normalizedTo);

          // Register a control-plane hangup callback so 46elks notifies us when
          // the call leg ends (including when the remote caller hangs up). This
          // is the inbound counterpart to the `whenhangup` set in makeCall for
          // outbound calls. Without it, inbound teardown relies solely on the
          // audio WebSocket closing, which can leave the call active on the
          // client if that socket lingers.
          const elks46Instance = entry.instance as Elks46TelephonyProvider;
          const whenhangup = elks46Instance.getHangupWebhookUrl();

          // Get the WebSocket number from provider config
          const providerConfig = entry.config as Record<string, string>;
          const wsNumber = providerConfig.websocket_number;

          if (wsNumber) {
            // Tell MediaBridge to expect a 46elks WebSocket connection for this session
            try {
              await callOrchestrator.patchSessionForWebsocketProvider(result.callId, '46elks', callId);
            } catch (patchErr) {
              server.log.warn(patchErr, '46elks inbound: failed to patch session with expected callId');
            }

            server.log.info(
              { callId, from: normalizedFrom, to: normalizedTo, wsNumber },
              '46elks inbound voice_start: returning WebSocket number connect',
            );
            return reply.status(200).send({
              connect: wsNumber,
              callerid: from,
              whenhangup,
            });
          }

          // Fallback to SIP URI if no WebSocket number configured
          server.log.info(
            { callId, from: normalizedFrom, to: normalizedTo, sipUri: result.sipUri },
            '46elks inbound voice_start: returning SIP connect (no WS number)',
          );
          return reply.status(200).send({
            connect: result.sipUri,
            callerid: from,
            whenhangup,
          });
        } catch (err) {
          server.log.error(err, `Failed to handle 46elks inbound call via CallOrchestrator`);
          return reply.status(200).send({ hangup: 'reject' });
        }
      }
    }

    // Fallback: delegate to the provider's generic webhook handler
    try {
      const result = await entry.instance.handleWebhook(endpoint, request.body, request);
      if (entry.type === '46elks') {
        server.log.info(
          { providerId, endpoint, requestBody: request.body, response: result },
          '46elks webhook handled',
        );
      }
      return reply.status(200).send(result);
    } catch (err) {
      log.error(err, `Webhook handler error for provider ${providerId}, endpoint: ${endpoint}`);
      return reply.status(500).send({
        error: 'Internal webhook handler error',
      });
    }
  });

  /**
   * Handle /webhooks/:providerId/answer (GET and POST)
   * Mirrors legacy /webhooks/answer behavior:
   * - GET: Vonage sends from/to as query params — always treat as inbound
   * - POST inbound PSTN calls: uses provider's generateAnswerNcco (SIP connect via CallOrchestrator)
   * - POST SDK-initiated outbound calls: parses custom_data for from/to, returns connect NCCO
   */
  async function handleAnswer(
    request: FastifyRequest,
    reply: FastifyReply,
    provider: VonageTelephonyProvider,
    _log: WebhookRouterLogger,
  ): Promise<unknown> {
    // GET requests from Vonage don't include direction — always treat as inbound
    if (request.method === 'GET') {
      const query = request.query as { from?: string; to?: string; uuid?: string };
      const from = query.from ?? '';
      const to = query.to ?? '';

      // Check if inbound calls are blocked for this number
      const normalizedTo = to.startsWith('+') ? to : `+${to}`;
      if (numberManagementService) {
        const blocked = await numberManagementService.isInboundBlocked(normalizedTo);
        if (blocked) {
          server.log.info(`[BlockedCall] Answer GET: blocking inbound call from=${from} to=${normalizedTo}`);
          // Record blocked call in history and notify devices
          const normalizedFrom = from.startsWith('+') ? from : (isDialableNumber(from) ? `+${from}` : from);
          const callId = `blocked-${Date.now()}`;
          await recordBlockedCallAndNotify(normalizedFrom, normalizedTo, callId);

          const blockNcco: NccoAction[] = [
            {
              action: 'talk',
              text: 'Det går inte att ringa till det här numret just nu. Skicka ett SMS istället.',
              bargeIn: false,
              language: 'sv-SE',
            },
          ];
          return reply
            .status(200)
            .header('Content-Type', 'application/json')
            .send(blockNcco);
        }
      }

      let ncco;

      // Route inbound call through CallOrchestrator to create MediaBridge session
      const providerId = (request.params as { providerId: string }).providerId;
      const providerCallId = query.uuid ?? '';
      if (callOrchestrator) {
        try {
          const normalizedFrom = from.startsWith('+') ? from : (isDialableNumber(from) ? `+${from}` : from);
          const result = await callOrchestrator.handleInbound(providerId, providerCallId, normalizedFrom, normalizedTo);
          ncco = provider.generateAnswerNcco({ from, to, sipUri: result.sipUri });
        } catch (err) {
          server.log.error(err, `Failed to handle inbound call via CallOrchestrator for provider ${providerId}`);
          // Fallback: silent hold (caller will hear nothing, but call won't crash Vonage)
          ncco = provider.generateAnswerNcco({ from, to });
        }
      } else {
        ncco = provider.generateAnswerNcco({ from, to });
      }

      server.log.info({ ncco, providerId, from, to, method: 'GET' }, 'Answer webhook returning NCCO');

      return reply
        .status(200)
        .header('Content-Type', 'application/json')
        .send(ncco);
    }

    // POST handler
    const body = request.body as {
      from?: string;
      to?: string;
      uuid?: string;
      conversation_uuid?: string;
      direction?: string;
      custom_data?: string;
      from_user?: string;
      to_user?: string;
      endpoint_type?: string;
    };

    server.log.info({ webhookBody: body }, 'Answer webhook received');

    const from = body.from ?? '';
    const to = body.to ?? '';

    let ncco;
    // Detect call type:
    // - endpoint_type="phone" with no custom_data → inbound PSTN call → connect to MediaBridge via SIP
    // - endpoint_type="app" or has custom_data or from_user → outbound SDK-initiated call → connect to phone
    const isInboundPstnCall = body.endpoint_type === 'phone' || (!body.custom_data && !body.from_user);

    if (isInboundPstnCall) {
      // Check if inbound calls are blocked for this number
      const normalizedTo = to.startsWith('+') ? to : `+${to}`;
      if (numberManagementService) {
        const blocked = await numberManagementService.isInboundBlocked(normalizedTo);
        if (blocked) {
          server.log.info(`[BlockedCall] Answer POST: blocking inbound call from=${from} to=${normalizedTo} uuid=${body.uuid}`);
          // Record blocked call in history and notify devices
          const normalizedFrom = from.startsWith('+') ? from : (isDialableNumber(from) ? `+${from}` : from);
          const callId = body.uuid ?? `blocked-${Date.now()}`;
          await recordBlockedCallAndNotify(normalizedFrom, normalizedTo, callId);

          const blockNcco: NccoAction[] = [
            {
              action: 'talk',
              text: 'Det går inte att ringa till det här numret just nu. Skicka ett SMS istället.',
              bargeIn: false,
              language: 'sv-SE',
            },
          ];
          return reply
            .status(200)
            .header('Content-Type', 'application/json')
            .send(blockNcco);
        }
      }

      // Inbound call: route through CallOrchestrator to create MediaBridge session and get sipUri
      const providerId = (request.params as { providerId: string }).providerId;
      const providerCallId = body.uuid ?? '';
      if (callOrchestrator) {
        try {
          const normalizedFrom = from.startsWith('+') ? from : (isDialableNumber(from) ? `+${from}` : from);
          const result = await callOrchestrator.handleInbound(providerId, providerCallId, normalizedFrom, normalizedTo);
          ncco = provider.generateAnswerNcco({ from, to, sipUri: result.sipUri });
        } catch (err) {
          server.log.error(err, `Failed to handle inbound call via CallOrchestrator for provider ${providerId}, uuid=${providerCallId}`);
          // Fallback: silent hold
          ncco = provider.generateAnswerNcco({ from, to });
        }
      } else {
        ncco = provider.generateAnswerNcco({ from, to });
      }
    } else {
      // Outbound SDK call: connect to the destination phone number from custom_data
      let customFrom = from;
      let customTo = to;
      if (body.custom_data) {
        try {
          const customData = JSON.parse(body.custom_data);
          customFrom = customData.from || from;
          customTo = customData.to || to;
        } catch {
          // custom_data wasn't valid JSON, use top-level from/to
        }
      }
      // Include explicit eventUrl so PSTN leg events are routed to this provider's webhook
      const providerId = (request.params as { providerId: string }).providerId;
      const eventUrl = webhookBaseUrl
        ? `${webhookBaseUrl}/webhooks/${providerId}/event`
        : undefined;
      ncco = buildOutboundCallNcco(customTo, customFrom, eventUrl);
    }

    server.log.info({ ncco, from, to, method: 'POST', isInboundPstnCall }, 'Answer webhook returning NCCO');

    return reply
      .status(200)
      .header('Content-Type', 'application/json')
      .send(ncco);
  }

  /**
   * Handle POST /webhooks/:providerId/event
   * Mirrors legacy POST /webhooks/event behavior:
   * - Filters SDK leg events (to starts with 'device-')
   * - Emits processCallEvent for PSTN legs
   * - Triggers push notification + records call history for inbound started events
   * - Records outbound calls in history when PSTN leg starts ringing
   */
  async function handleEvent(
    request: FastifyRequest,
    reply: FastifyReply,
    provider: VonageTelephonyProvider,
    _log: WebhookRouterLogger,
  ): Promise<unknown> {
    const body = request.body as {
      uuid?: string;
      status?: string;
      from?: string;
      to?: string;
      direction?: string;
      duration?: string;
      timestamp?: string;
      conversation_uuid?: string;
    };

    // Log call events for debugging
    server.log.info(
      { eventBody: { uuid: body.uuid, status: body.status, direction: body.direction, from: body.from, to: body.to } },
      'Event webhook received'
    );

    // Skip SDK leg events (legs connecting Vonage to app users).
    // These are internal Vonage events for the app user delivery leg, not actual PSTN call state changes.
    // SDK legs can be identified by the 'to' field starting with 'device-' (the provider_user_name pattern).
    const isInternalSdkLeg = body.to?.startsWith('device-');

    // Check if inbound calls are blocked for this number — if so, suppress ALL
    // provider event emissions (started, answered, completed, etc.) to prevent
    // the call from appearing as active in the app via WebSocket or activeCalls.
    let isBlockedInbound = false;
    if (
      !isInternalSdkLeg &&
      body.direction === 'inbound' &&
      body.to &&
      numberManagementService
    ) {
      const normalizedTo = body.to.startsWith('+') ? body.to : `+${body.to}`;
      isBlockedInbound = await numberManagementService.isInboundBlocked(normalizedTo);
    }

    if (!isInternalSdkLeg && !isBlockedInbound) {
      // When callOrchestrator is available, skip processCallEvent entirely.
      // The orchestrator manages the full call lifecycle via MediaBridge session events
      // and uses internal callIds. Broadcasting Vonage's raw UUID-based events to clients
      // causes the Android app to incorrectly terminate calls (the Vonage UUID doesn't
      // match the internal callId the app is tracking).
      const shouldSkipProcessEvent = !!callOrchestrator;

      if (!shouldSkipProcessEvent) {
        provider.processCallEvent({
          uuid: body.uuid,
          status: body.status,
          from: body.from,
          to: body.to,
          direction: body.direction,
          duration: body.duration,
          timestamp: body.timestamp,
        });
      }
    }

    // Trigger push notification for inbound calls that are starting.
    // Skip entirely when callOrchestrator is available — handleInbound sends its own notifications.
    const isAlreadyHandledByOrchestrator = !!callOrchestrator;

    if (
      body.direction === 'inbound' &&
      body.status === 'started' &&
      body.uuid &&
      body.from &&
      body.to &&
      !isInternalSdkLeg &&
      !isAlreadyHandledByOrchestrator
    ) {
      const rawTo = body.to!;
      const toNumber = rawTo.startsWith('+') ? rawTo : `+${rawTo}`;

      // If the call is blocked, the answer webhook already recorded it and notified devices.
      // Just skip the normal incoming call flow here.
      if (!isBlockedInbound) {
        // Normal flow: record as INCOMING and notify devices
        if (callHistoryService) {
          const rawFrom = body.from!;
          const fromNumber = isDialableNumber(rawFrom)
            ? (rawFrom.startsWith('+') ? rawFrom : `+${rawFrom}`)
            : rawFrom;
          callHistoryService.recordCall({
            phone_number: fromNumber,
            provider_number: toNumber,
            call_type: 'INCOMING',
            provider_call_id: body.uuid!,
          }).catch(() => {
            // Ignore errors (duplicate entry or FK constraint if number not yet synced)
          });
        }

        // Send wake signals to all registered devices via UnifiedPush
        if (wakeSignalPublisher && deviceRegistryManager) {
          deviceRegistryManager.getActiveDevicesWithPushInfo().then((devices) => {
            if (devices.length > 0) {
              wakeSignalPublisher.sendToAllDevices(devices, {
                id: body.uuid!,
                priority: 'high',
              }, 'incoming_call_legacy').catch((err) => {
                server.log.error(err, 'Failed to send wake signals for incoming call');
              });
            }
          }).catch((err) => {
            server.log.error(err, 'Failed to get devices for incoming call wake signal');
          });
        }
      }
    }

    // When an inbound call completes, Vonage may reveal the real caller number
    // in the "from" field even if the caller used CLIR (anonymous). Store it
    // separately for internal use (spam detection, logging) without surfacing it
    // as the caller identity to the user.
    if (
      body.direction === 'inbound' &&
      body.status === 'completed' &&
      body.uuid &&
      body.from &&
      !isInternalSdkLeg &&
      callHistoryService
    ) {
      const rawFrom = body.from;
      // Only store if it looks like a real phone number (not "anonymous" or similar)
      if (rawFrom && /^\+?\d{5,}$/.test(rawFrom)) {
        const normalizedFrom = rawFrom.startsWith('+') ? rawFrom : `+${rawFrom}`;
        callHistoryService.setRevealedNumber(body.uuid, normalizedFrom).catch(() => {
          // Best-effort — ignore errors (entry might not exist yet or column constraint)
        });
      }
    }

    // Record outbound calls in call history when the PSTN leg starts ringing.
    // SDK-initiated outbound calls don't go through POST /api/calls/make,
    // so we record them here when Vonage reports the outbound PSTN leg.
    // Skip outbound legs to SIP URIs (our own MediaBridge) — these are internal.
    if (
      body.direction === 'outbound' &&
      body.status === 'ringing' &&
      body.uuid &&
      body.to &&
      !isInternalSdkLeg &&
      !body.to.startsWith('sip')
    ) {
      if (callHistoryService) {
        const toNumber = body.to!.startsWith('+') ? body.to! : `+${body.to!}`;
        const fromNumber = body.from ? (body.from.startsWith('+') ? body.from : `+${body.from}`) : null;
        callHistoryService.recordCall({
          phone_number: toNumber,
          provider_number: fromNumber,
          call_type: 'OUTGOING',
          provider_call_id: body.uuid!,
        }).catch(() => {
          // Ignore errors (duplicate entry from /api/calls/make path)
        });
      }
    }

    return reply.status(200).send({});
  }

  /**
   * Handle /webhooks/:providerId/inbound-sms (GET and POST)
   * Mirrors legacy /webhooks/inbound-sms behavior:
   * - POST: Vonage Messages API webhook format
   * - GET: Legacy Vonage SMS API format (query params with msisdn)
   * - Normalizes numbers to E.164
   * - Validates required fields
   * - Uses conversationService.receiveMessage() directly
   * - Sends wake signals for incoming SMS
   */
  async function handleInboundSms(
    request: FastifyRequest,
    reply: FastifyReply,
    provider: VonageTelephonyProvider,
    _log: WebhookRouterLogger,
  ): Promise<unknown> {
    // GET: legacy Vonage SMS API sends inbound SMS via query params
    if (request.method === 'GET') {
      const query = request.query as {
        messageId?: string;
        msisdn?: string;
        to?: string;
        text?: string;
        'message-timestamp'?: string;
      };

      const rawFrom = query.msisdn ?? '';
      const rawTo = query.to ?? '';
      const from = normalizeInboundNumber(rawFrom);
      const to = rawTo.startsWith('+') ? rawTo : `+${rawTo}`;
      const messageId = query.messageId ?? `legacy-${Date.now()}`;
      const text = query.text ?? '';
      const timestamp = query['message-timestamp'] ? new Date(query['message-timestamp']) : new Date();

      if (!rawFrom) {
        return reply.status(400).send({});
      }

      try {
        if (conversationService) {
          await conversationService.receiveMessage(messageId, from, to, text, timestamp);
        } else {
          provider.processSmsEvent({
            message_uuid: query.messageId,
            from: query.msisdn,
            to: query.to,
            text: query.text,
            timestamp: query['message-timestamp'],
          });
        }
        return reply.status(200).send({});
      } catch (err) {
        server.log.error(err, 'Failed to process inbound SMS webhook (GET)');
        return reply.status(500).send({});
      }
    }

    // POST: Vonage Messages API format
    const body = request.body as {
      message_uuid?: string;
      from?: string;
      to?: string;
      text?: string;
      timestamp?: string;
    };

    const rawFrom = body.from ?? '';
    const rawTo = body.to ?? '';
    const from = normalizeInboundNumber(rawFrom);
    const to = rawTo.startsWith('+') ? rawTo : `+${rawTo}`;
    const messageId = body.message_uuid ?? '';
    const text = body.text ?? '';
    const timestamp = body.timestamp ? new Date(body.timestamp) : new Date();

    if (!messageId || !from || from === '+' || !from) {
      return reply.status(400).send({});
    }

    try {
      if (conversationService) {
        await conversationService.receiveMessage(messageId, from, to, text, timestamp);
      } else {
        // Fallback: emit event for async processing
        provider.processSmsEvent({
          message_uuid: body.message_uuid,
          from: body.from,
          to: body.to,
          text: body.text,
          timestamp: body.timestamp,
        });
      }

      // Create notification for incoming SMS (handles WS broadcast + wake signal delivery)
      if (notificationService && numberManagementService && messageId) {
        const numberRecord = (await numberManagementService.getNumbers()).find((n) => n.number === to);
        notificationService.createNotification({
          type: 'incoming_sms',
          sourceEntityId: messageId,
          sourceEntityType: 'messages',
          payload: {
            senderNumber: from,
            providerNumber: to,
            providerLabel: numberRecord?.label ?? undefined,
            contactName: null,
            messagePreview: text.length > 160 ? text.substring(0, 160) : text,
            timestamp: timestamp.toISOString(),
          },
        }).catch((err) => {
          server.log.error(err, 'Failed to create incoming SMS notification');
        });
      }

      return reply.status(200).send({});
    } catch (err) {
      server.log.error(err, 'Failed to process inbound SMS webhook');
      return reply.status(500).send({});
    }
  }

  /**
   * Handle POST /webhooks/:providerId/sms-status
   * Mirrors legacy POST /webhooks/sms-status behavior.
   */
  async function handleSmsStatus(
    request: FastifyRequest,
    reply: FastifyReply,
    provider: VonageTelephonyProvider,
  ): Promise<unknown> {
    const body = request.body as {
      message_uuid?: string;
      status?: string;
    };

    provider.processSmsStatusEvent({
      message_uuid: body.message_uuid,
      status: body.status,
    });

    return reply.status(200).send({});
  }
}
