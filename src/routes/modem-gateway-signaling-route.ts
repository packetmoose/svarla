import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ProviderRegistry } from '../services/provider-registry.js';
import { ModemGatewayTelephonyProvider } from '../providers/modem-gateway-telephony-provider.js';

/**
 * Register the WebSocket signaling route for modem-gateway providers.
 *
 * Route: GET /ws/providers/:id/signaling (WebSocket upgrade)
 *
 * The modem-gateway binary connects to this endpoint to establish the persistent
 * signaling WebSocket used for authentication, SMS, call control, DTMF, USSD,
 * and status reporting.
 *
 * Requirements: 1.2, 3.1
 */
export function registerModemGatewaySignalingRoute(
  server: FastifyInstance,
  registry: ProviderRegistry,
): void {
  server.get('/ws/providers/:id/signaling', { websocket: true }, (socket, request: FastifyRequest) => {
    const { id } = request.params as { id: string };

    // Look up the provider by ID
    const providerEntry = registry.getProvider(id);

    if (!providerEntry) {
      server.log.warn(`WebSocket signaling: provider ${id} not found`);
      socket.close(4404, 'Provider not found');
      return;
    }

    // Verify it's a modem-gateway provider
    if (providerEntry.type !== 'modem-gateway') {
      server.log.warn(`WebSocket signaling: provider ${id} is type "${providerEntry.type}", not modem-gateway`);
      socket.close(4400, 'Provider is not a modem-gateway type');
      return;
    }

    // Get the provider instance
    const providerInstance = providerEntry.instance;
    if (!providerInstance) {
      server.log.warn(`WebSocket signaling: provider ${id} has no active instance`);
      socket.close(4503, 'Provider is not active');
      return;
    }

    // Get the WS handler from the provider
    const modemGatewayProvider = providerInstance as ModemGatewayTelephonyProvider;
    const wsHandler = modemGatewayProvider.getWsHandler();

    if (!wsHandler) {
      server.log.warn(`WebSocket signaling: provider ${id} has no WS handler`);
      socket.close(4503, 'Provider WS handler not initialized');
      return;
    }

    server.log.info(`WebSocket signaling: modem-gateway binary connecting to provider ${id}`);

    // Delegate the WebSocket connection to the handler
    wsHandler.handleConnection(socket);
  });
}
