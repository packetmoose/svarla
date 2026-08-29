import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { createDatabase } from './database.js';
import { getVersionInfo } from './version.js';
import { AuthService } from './services/auth-service.js';
import { DeviceRegistryManager } from './services/device-registry-manager.js';
import { NumberManagementService } from './services/number-management-service.js';
import { CallHistoryService } from './services/call-history-service.js';
import { ConversationService } from './services/conversation-service.js';
import { ReadStateService } from './services/read-state-service.js';
import { WebSocketBroadcaster } from './websocket/broadcaster.js';
import { WsTicketService } from './services/ws-ticket-service.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerDeviceRoutes } from './routes/device-routes.js';
import { registerNumberRoutes } from './routes/number-routes.js';
import { registerCallRoutes } from './routes/call-routes.js';
import { registerSmsRoutes } from './routes/sms-routes.js';
import { registerReadStateRoutes } from './routes/read-state-routes.js';
import { registerSyncRoutes } from './routes/sync-routes.js';
import { registerNotificationRoutes } from './routes/notification-routes.js';
import { registerSessionMiddleware } from './middleware/session-middleware.js';
import { registerWebhookRouter } from './routes/webhook-router.js';
import { registerProviderRoutes } from './routes/provider-routes.js';
import { ProviderRegistry } from './services/provider-registry.js';
import type { TelephonyProvider } from './providers/telephony-provider.js';
import { VonageTelephonyProvider } from './providers/vonage-telephony-provider.js';
import { DummyTelephonyProvider } from './providers/dummy-telephony-provider.js';
import { Elks46TelephonyProvider } from './providers/elks46-telephony-provider.js';
import { ModemGatewayTelephonyProvider } from './providers/modem-gateway-telephony-provider.js';
import { ModemGatewayWsHandler } from './providers/modem-gateway-ws-handler.js';
import { ModemGatewayDbPersistence } from './providers/modem-gateway-persistence.js';
import { registerModemGatewaySignalingRoute } from './routes/modem-gateway-signaling-route.js';
import { WakeSignalPublisher } from './notifications/wake-signal-publisher.js';
import { MediaBridgeClient } from './services/media-bridge-client.js';
import { MediaBridgeEventListener } from './services/media-bridge-event-listener.js';
import { MediaBridgeFailureDetector } from './services/media-bridge-failure-detector.js';
import { CallOrchestrator } from './services/call-orchestrator.js';
import { NotificationService } from './services/notification-service.js';

/**
 * Factory function that creates a TelephonyProvider instance from a type and config.
 * Used by ProviderRegistry to instantiate providers loaded from the database.
 * The serverWebhookBaseUrl is used as a fallback when the provider config doesn't specify one.
 */
function createProviderFactory(serverWebhookBaseUrl: string) {
  return function createProviderFromConfig(type: string, config: Record<string, unknown>): TelephonyProvider {
    switch (type) {
      case 'vonage':
        return new VonageTelephonyProvider({
          apiKey: (config.api_key as string) ?? '',
          apiSecret: (config.api_secret as string) ?? '',
          applicationId: (config.application_id as string) ?? '',
          privateKey: (config.private_key as string) || undefined,
          privateKeyPath: (config.private_key_path as string) || undefined,
          webhookBaseUrl: (config.webhook_base_url as string) || serverWebhookBaseUrl,
          supportsSips: config.supports_sips != null ? Boolean(config.supports_sips) : undefined,
        });
      case '46elks':
        return new Elks46TelephonyProvider({
          apiUsername: (config.api_username as string) ?? '',
          apiPassword: (config.api_password as string) ?? '',
          webhookBaseUrl: (config.webhook_base_url as string) || serverWebhookBaseUrl,
          registryId: config._registryId as string | undefined,
          websocketNumber: (config.websocket_number as string) || undefined,
        });
      case 'dummy':
        return new DummyTelephonyProvider({
          numbers: config.numbers as string[] | undefined,
        });
      case 'modem-gateway':
        return new ModemGatewayTelephonyProvider({
          registryId: config._registryId as string,
        });
      default:
        throw new Error(`Unknown telephony provider type: ${type}`);
    }
  };
}

/**
 * Build and configure the Fastify server instance.
 * Sets up Pino logging, plugin registration, and error handling.
 */
export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        !config.logJson
          ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
          : undefined,
    },
  });

  // --- Security plugins ---

  // Rate limiting: global default + stricter per-route overrides
  // Rate limiting: global default + stricter per-route overrides
  const rateLimitPlugin = await import('@fastify/rate-limit');
  await server.register(rateLimitPlugin.default, {
    max: 100,           // 100 requests per minute globally
    timeWindow: '1 minute',
    allowList: [],
  });

  // Form-encoded body parsing (required for 46elks webhooks which POST as application/x-www-form-urlencoded)
  const formbodyPlugin = await import('@fastify/formbody');
  await server.register(formbodyPlugin.default);

  // CORS: restrict origins when configured
  const corsPlugin = await import('@fastify/cors');
  const corsOrigin = config.corsOrigin;
  await server.register(corsPlugin.default, {
    origin: corsOrigin
      ? corsOrigin.split(',').map((o) => o.trim())
      : config.env.NODE_ENV === 'development'
        ? true  // Allow all in development
        : false, // Deny all cross-origin in production when no origin configured
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Security headers
  const helmetPlugin = await import('@fastify/helmet');
  await server.register(helmetPlugin.default, {
    contentSecurityPolicy: config.webInterfaceEnabled
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'", 'wss:', 'ws:'],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false, // Breaks some WebSocket clients
  });

  // Database
  const db = createDatabase(config);

  // ProviderRegistry — manages all active telephony provider instances
  const webhookBaseUrl = config.baseUrl;
  const registry = new ProviderRegistry(
    db,
    webhookBaseUrl,
    server.log,
    createProviderFactory(webhookBaseUrl),
    config.configEncryptionKey || undefined,
  );

  // Load all enabled providers from the database
  await registry.loadAll();

  // Wire up ModemGatewayWsHandler for each active modem-gateway provider
  for (const entry of registry.listProviders()) {
    if (entry.type === 'modem-gateway' && entry.status === 'active' && entry.instance) {
      const persistence = new ModemGatewayDbPersistence(db, entry.id);
      const wsHandler = new ModemGatewayWsHandler(persistence, server.log);
      (entry.instance as ModemGatewayTelephonyProvider).setWsHandler(wsHandler);
      server.log.info(`WsHandler attached to modem-gateway provider "${entry.displayName}" (${entry.id})`);
    }
  }

  // Get the first active provider instance for services that still need a single provider
  // (ConversationService, legacy webhook routes, call routes)
  const activeProviders = registry.listProviders().filter(
    (p) => p.status === 'active' && p.instance != null
  );
  const primaryProvider: TelephonyProvider | null = activeProviders.length > 0
    ? activeProviders[0].instance
    : null;

  // Services
  const deviceRegistryManager = new DeviceRegistryManager(db);

  // Wake signal publisher for UnifiedPush notifications
  const wakeSignalPublisher = new WakeSignalPublisher();

  // In-memory active call tracking for late-joining clients.
  // Tracks calls that are currently in RINGING or CONNECTED state.
  const activeCalls = new Map<string, { callId: string; status: string; from?: string; providerNumber?: string; startedAt: number }>();

  // --- MediaBridge integration ---
  // Initialize MediaBridgeClient for ControlAPI communication
  const mediaBridgeClient = new MediaBridgeClient({
    baseUrl: config.mediaBridge.url,
    healthCheckInterval: config.mediaBridge.healthCheckInterval,
    logger: server.log,
  });

  // Start health check polling — logs warnings when MediaBridge is unavailable
  mediaBridgeClient.startHealthChecks();

  // Initialize MediaBridge event listener (WebSocket client connecting to MediaBridge)
  const mediaBridgeEventListener = new MediaBridgeEventListener({
    url: config.mediaBridge.eventWebSocketUrl,
    logger: server.log,
  });

  // Connect to the MediaBridge event WebSocket endpoint
  await mediaBridgeEventListener.start();
  server.log.info(
    `MediaBridge event WebSocket client connecting to ${config.mediaBridge.eventWebSocketUrl}`
  );

  // AuthService
  const authService = new AuthService(db, {
    sessionExpiryDays: config.sessionExpiryDays,
  });

  // WS ticket service for secure WebSocket connections
  const wsTicketService = new WsTicketService();

  // WebSocket broadcaster for real-time events
  const wsBroadcaster = new WebSocketBroadcaster(authService, wsTicketService);

  const numberManagementService = new NumberManagementService(db, registry, (event) => {
    wsBroadcaster.broadcast({ type: 'numbers_changed', data: event as unknown as Record<string, unknown> });
  }, server.log);
  const callHistoryService = new CallHistoryService(db, (event) => {
    wsBroadcaster.broadcast({ type: event.type, data: event.entry as unknown as Record<string, unknown> });
  });

  // ConversationService still expects a single TelephonyProvider.
  // Pass the first active provider from the registry if available.
  // If no provider is active, create a no-op stub to avoid null errors.
  const conversationProvider: TelephonyProvider = primaryProvider ?? createNoOpProvider();
  const conversationService = new ConversationService(db, conversationProvider, (event) => {
    // Send lightweight notification — client will sync the actual data
    if (event.type === 'new_message') {
      const data = event.data as { conversationNumber: string; message: { id: string; direction: string } };
      wsBroadcaster.broadcast({
        type: 'new_message',
        data: {
          conversationNumber: data.conversationNumber,
          messageId: data.message.id,
          direction: data.message.direction,
        },
      });
    } else {
      wsBroadcaster.broadcast({ type: event.type, data: event.data as unknown as Record<string, unknown> });
    }
  });
  const readStateService = new ReadStateService(db, () => {});

  // --- NotificationService ---
  // Manages the full notification lifecycle: creation, state mutations, delivery, and cross-device sync.
  const notificationService = new NotificationService({
    db,
    wsBroadcaster,
    wakeSignalPublisher,
    deviceRegistryManager,
    logger: server.log,
  });

  // --- CallOrchestrator ---
  // Coordinates the full call lifecycle between clients, MediaBridge, and providers.
  const callOrchestrator = new CallOrchestrator({
    mediaBridgeClient: mediaBridgeClient,
    providerRegistry: registry,
    numberManagementService,
    callHistoryService,
    wsBroadcaster,
    deviceRegistryManager,
    wakeSignalPublisher,
    notificationService,
    logger: server.log,
    sipTlsEnabled: config.mediaBridge.sip.tls,
  });

  // Wire MediaBridge session events to CallOrchestrator
  mediaBridgeEventListener.onSessionEvent((event) => {
    callOrchestrator.handleMediaEvent(event);
  });

  // Wire incoming ICE candidate messages from clients to CallOrchestrator
  wsBroadcaster.onIceCandidate((deviceId, message) => {
    callOrchestrator.handleIceCandidate(message.callId, deviceId, message.candidate);
  });

  // --- MediaBridge failure detection ---
  // Monitors health check polling and event WebSocket connection.
  // On failure: ends all active calls and notifies clients.
  const mediaBridgeFailureDetector = new MediaBridgeFailureDetector(
    {
      mediaBridgeClient,
      mediaBridgeEventListener,
      callOrchestrator,
      wsBroadcaster,
    },
    { logger: server.log },
  );
  mediaBridgeFailureDetector.start();

  // Sync numbers from all active providers into DB on startup
  for (const providerEntry of activeProviders) {
    try {
      const syncResult = await numberManagementService.syncNumbers(providerEntry.id);
      if (syncResult.added.length > 0 || syncResult.removed.length > 0) {
        server.log.info(
          `Numbers synced for provider "${providerEntry.displayName}": ${syncResult.added.length} added, ${syncResult.removed.length} removed, ${syncResult.total} total`
        );
      } else {
        server.log.info(
          `Numbers synced for provider "${providerEntry.displayName}": no changes (${syncResult.total} total)`
        );
      }
    } catch (err) {
      server.log.warn(err, `Failed to sync numbers from provider "${providerEntry.displayName}" on startup`);
    }
  }

  // Wire up provider events to services for all active providers
  for (const providerEntry of activeProviders) {
    const providerInstance = providerEntry.instance!;
    providerInstance.onEvent((event) => {
      if (event.type === 'incoming_sms') {
        conversationService
          .receiveMessage(event.messageId, event.from, event.to, event.body, new Date(event.timestamp))
          .then(async (msg) => {
            if (msg) {
              server.log.info(`Received inbound SMS from ${event.from} → ${event.to}`);

              // Create notification for incoming SMS (handles WS broadcast + wake signal delivery)
              const numberRecord = (await numberManagementService.getNumbers()).find((n) => n.number === event.to);
              notificationService
                .createNotification({
                  type: 'incoming_sms',
                  sourceEntityId: event.messageId,
                  sourceEntityType: 'messages',
                  payload: {
                    senderNumber: event.from,
                    providerNumber: event.to,
                    providerLabel: numberRecord?.label ?? undefined,
                    contactName: null,
                    messagePreview: event.body.length > 160 ? event.body.substring(0, 160) : event.body,
                    timestamp: new Date(event.timestamp).toISOString(),
                  },
                })
                .catch((err) => {
                  server.log.error(err, 'Failed to create incoming SMS notification');
                });
            }
          })
          .catch((err) => {
            server.log.error(err, 'Failed to process incoming SMS event');
          });
      } else if (event.type === 'call_state_changed') {
        // If this call is managed by the orchestrator, route the event through it
        // instead of broadcasting raw provider callIds (which don't match the
        // internal callId the clients are tracking).
        const internalCallId = callOrchestrator.getCallIdByProviderCallId(event.callId);
        if (internalCallId) {
          const isCallEnded =
            event.state === 'COMPLETED' || event.state === 'FAILED' || event.state === 'BUSY';
          if (isCallEnded) {
            // Trigger endCall through the orchestrator — this will broadcast the
            // correct internal callId to clients and handle cleanup properly.
            callOrchestrator.endCall(internalCallId, 'provider_call_state_changed').catch((err) => {
              server.log.error(err, `Failed to end orchestrator call ${internalCallId} via call_state_changed`);
            });
          } else if (event.state === 'ANSWERED') {
            // Provider reports answered — the orchestrator handles this via
            // provider_connected media event, but broadcast with correct ID as backup.
            const wsEvent = {
              type: 'call_event' as const,
              data: {
                callId: internalCallId,
                status: 'connected',
              },
            };
            wsBroadcaster.broadcast(wsEvent);
          }
          // Skip the legacy handler for orchestrator-managed calls
          return;
        }

        // Legacy path: call not managed by orchestrator — broadcast with provider callId
        // Broadcast call state changes to all connected devices via WebSocket
        let status: string;
        switch (event.state) {
          case 'RINGING': status = 'ringing'; break;
          case 'ANSWERED': status = 'connected'; break;
          case 'COMPLETED': status = 'completed'; break;
          case 'FAILED': status = 'failed'; break;
          case 'BUSY': status = 'busy'; break;
          default: status = String(event.state).toLowerCase(); break;
        }
        const wsEvent = {
          type: 'call_event' as const,
          data: {
            callId: event.callId,
            status,
            ...(event.durationSeconds != null && { durationSeconds: event.durationSeconds }),
          },
        };
        wsBroadcaster.broadcast(wsEvent);

        // Track active calls for late-joining clients
        if (event.state === 'ANSWERED') {
          const existing = activeCalls.get(event.callId);
          activeCalls.set(event.callId, {
            callId: event.callId,
            status: 'connected',
            from: existing?.from,
            providerNumber: existing?.providerNumber,
            startedAt: existing?.startedAt ?? Date.now(),
          });
        }

        const isCallEnded =
          event.state === 'COMPLETED' || event.state === 'FAILED' || event.state === 'BUSY';

        if (isCallEnded && event.callId) {
          activeCalls.delete(event.callId);
          callHistoryService.updateCallTypeByProviderCallId(event.callId, 'MISSED')
            .then((updatedEntry) => {
              if (updatedEntry) {
                server.log.info(`Call ${event.callId} marked as MISSED in call history`);

                const cancelEvent = {
                  type: 'call_cancelled' as const,
                  data: {
                    callId: event.callId,
                    reason: 'caller_disconnect' as const,
                  },
                };
                wsBroadcaster.broadcast(cancelEvent);

                deviceRegistryManager.getActiveDevicesWithPushInfo().then((devices) => {
                  if (devices.length > 0) {
                    wakeSignalPublisher.sendToAllDevices(devices, {
                      id: updatedEntry.id,
                      priority: 'normal',
                    }).catch((err) => {
                      server.log.error(err, 'Failed to send missed_call wake signals');
                    });
                  }
                }).catch((err) => {
                  server.log.error(err, 'Failed to get devices for missed_call wake signal');
                });
              } else {
                if (event.state === 'COMPLETED' && event.durationSeconds != null && event.durationSeconds > 0) {
                  callHistoryService.updateDurationByProviderCallId(event.callId, event.durationSeconds)
                    .catch((err) => {
                      server.log.error(err, `Failed to update duration for call ${event.callId}`);
                    });
                } else {
                  callHistoryService.markOutboundUnanswered(event.callId)
                    .then((outboundEntry) => {
                      if (outboundEntry) {
                        server.log.info(`Outbound call ${event.callId} marked as UNANSWERED in call history`);
                      }
                    })
                    .catch((err) => {
                      server.log.error(err, `Failed to mark outbound call ${event.callId} as UNANSWERED`);
                    });
                }
              }
            })
            .catch((err) => {
              server.log.error(err, `Failed to update call ${event.callId} to MISSED`);
            });
        }
      } else if (event.type === 'incoming_call') {
        // Skip if this call is already tracked by the orchestrator (handleInbound already notified devices).
        if (callOrchestrator.getCallIdByProviderCallId(event.callId)) {
          return;
        }

        // A missing caller ID means the caller withheld their number (CLIR).
        // Represent it as "anonymous", matching the 46elks provider behavior.
        const callerFrom = event.from && event.from.trim() !== '' ? event.from : 'anonymous';

        // Route through the CallOrchestrator for proper call history, notifications,
        // and MediaBridge session management.
        callOrchestrator.handleInbound(providerEntry.id, event.callId, callerFrom, event.to)
          .then((result) => {
            server.log.info(
              { callId: result.callId, providerCallId: event.callId, from: callerFrom, to: event.to },
              'Inbound call routed through orchestrator',
            );
          })
          .catch((err) => {
            server.log.error(err, `Failed to handle inbound call via orchestrator for provider "${providerEntry.displayName}"`);
          });
      }
    });
  }

  // Wire up automatic number sync for modem-gateway providers.
  // When a number_report is received, trigger syncNumbers() so the number
  // is persisted to the database immediately without requiring manual sync.
  for (const providerEntry of activeProviders) {
    if (providerEntry.type === 'modem-gateway') {
      const modemProvider = providerEntry.instance as ModemGatewayTelephonyProvider;
      const providerId = providerEntry.id;
      modemProvider.onNumberReport(() => {
        numberManagementService.syncNumbers(providerId).catch((err) => {
          server.log.error(err, `Auto-sync numbers failed for provider "${providerEntry.displayName}" after number_report`);
        });
      });
    }
  }

  // Middleware
  registerSessionMiddleware(server, authService, { webInterfaceEnabled: config.webInterfaceEnabled });

  // WebSocket endpoint for real-time sync
  await wsBroadcaster.register(server);

  // Modem-gateway signaling WebSocket endpoint
  registerModemGatewaySignalingRoute(server, registry);

  // Routes
  registerAuthRoutes(server, authService, wsTicketService, wsBroadcaster, wakeSignalPublisher, () =>
    deviceRegistryManager.getActiveDevicesWithPushInfo()
  );
  registerDeviceRoutes(server, deviceRegistryManager, {
    pushEndpointSsrfProtection: !config.pushAllowPrivateEndpoints,
  });
  registerNumberRoutes(server, numberManagementService);
  registerCallRoutes(server, callHistoryService, callOrchestrator);
  registerSmsRoutes(server, conversationService, numberManagementService);
  registerReadStateRoutes(server, readStateService);
  registerSyncRoutes(server, db);
  registerNotificationRoutes(server, notificationService);

  // Provider management API routes
  registerProviderRoutes(server, registry);

  // Dynamic webhook router — routes /webhooks/:providerId/* to the correct provider
  registerWebhookRouter(server, registry, {
    callHistoryService,
    conversationService,
    wakeSignalPublisher,
    deviceRegistryManager,
    numberManagementService,
    wsBroadcaster,
    callOrchestrator,
    notificationService,
    webhookBaseUrl,
  });

  // Serve static files from /public (ringback tones, etc.)
  const staticPlugin = await import('@fastify/static');
  await server.register(staticPlugin.default, {
    root: join(process.cwd(), 'public'),
    prefix: '/public/',
    decorateReply: false,
  });

  // APK download status endpoint — lets the frontend know if the APK is available
  const apkPath = process.env.APK_PATH || join(process.cwd(), 'public', 'downloads', 'svarla.apk');
  server.get('/api/download/status', async () => {
    let isAvailable = false;
    try {
      if (existsSync(apkPath)) {
        const stats = statSync(apkPath);
        isAvailable = stats.size > 1000;
      }
    } catch {
      isAvailable = false;
    }
    return { available: isAvailable, url: '/public/downloads/svarla.apk' };
  });

  // Conditionally register web interface routes based on config
  if (config.webInterfaceEnabled) {
    const webDistPath = join(process.cwd(), 'dist', 'web');
    try {
      if (existsSync(webDistPath)) {
        await server.register(staticPlugin.default, {
          root: webDistPath,
          prefix: '/',
          decorateReply: false,
          wildcard: false,
        });

        // SPA fallback: serve index.html for any GET request that doesn't match
        // API routes (/api/*), webhook routes (/webhooks/*), public static files (/public/*),
        // or other known server routes (like /health).
        server.get('/*', async (request, reply) => {
          const url = request.url.split('?')[0]; // strip query string
          if (
            url.startsWith('/api/') ||
            url.startsWith('/webhooks/') ||
            url.startsWith('/public/') ||
            url === '/health'
          ) {
            // Let Fastify's 404 handler deal with unmatched API/webhook/public paths
            return reply.callNotFound();
          }
          return reply.sendFile('index.html');
        });

        server.log.info('Web interface enabled and serving from /');
      } else {
        server.log.warn('Web interface enabled but dist/web/ not found — skipping static file registration');
      }
    } catch {
      server.log.warn('Failed to register web interface static files');
    }
  }

  // Health check
  server.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Version endpoint — used by the mobile app to check compatibility
  server.get('/api/version', async () => {
    const versionInfo = getVersionInfo();
    return versionInfo;
  });

  // Global error handler
  server.setErrorHandler((error, request, reply) => {
    server.log.error(
      { err: error, requestId: request.id, url: request.url },
      'Unhandled error'
    );

    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : error.message,
      statusCode,
    });
  });

  // Global not-found handler
  server.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      statusCode: 404,
    });
  });

  // Graceful shutdown hooks
  server.addHook('onClose', async () => {
    server.log.info('Server shutting down gracefully');
    mediaBridgeFailureDetector.stop();
    mediaBridgeClient.stopHealthChecks();
    await mediaBridgeEventListener.stop();
    callOrchestrator.dispose();
    wsTicketService.destroy();
  });

  return server;
}

/**
 * Creates a no-op TelephonyProvider stub for when no providers are active.
 * This prevents null errors in services that require a provider reference.
 */
function createNoOpProvider(): TelephonyProvider {
  return {
    providerId: 'no-op',
    async makeCall() { throw new Error('No active telephony provider available'); },
    async endCall() { throw new Error('No active telephony provider available'); },
    async answerCall() { throw new Error('No active telephony provider available'); },
    async sendSms() { throw new Error('No active telephony provider available'); },
    async listNumbers() { return []; },
    onEvent() {},
    async start() {},
    async stop() {},
    getWebhookEndpoints() { return []; },
    async handleWebhook() { return {}; },
  };
}
