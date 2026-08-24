import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ProviderRegistry } from '../services/provider-registry.js';
import {
  ProviderValidationError,
  ProviderNotFoundError,
  ProviderRemovalBlockedError,
} from '../services/provider-registry.js';
import { ModemGatewayTelephonyProvider } from '../providers/modem-gateway-telephony-provider.js';
import { getSupportedProviderTypes } from '../validators/provider-config-validator.js';

/**
 * Fields considered secret per provider type.
 * These fields are masked when returning provider details.
 */
const SECRET_FIELDS: Record<string, string[]> = {
  vonage: ['api_secret', 'private_key', 'private_key_path'],
  '46elks': ['api_password'],
  dummy: [],
  'modem-gateway': ['pairing_secret'],
};

/**
 * Mask a secret string: shows asterisks followed by the last 4 characters.
 * Strings shorter than 4 characters are fully masked with asterisks.
 */
function maskSecret(value: string): string {
  if (value.length <= 4) {
    return '*'.repeat(value.length);
  }
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

/**
 * Mask secret fields in a provider config object based on the provider type.
 */
function maskConfig(
  type: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const secretFields = SECRET_FIELDS[type] ?? [];
  const masked: Record<string, unknown> = { ...config };

  for (const field of secretFields) {
    if (typeof masked[field] === 'string') {
      masked[field] = maskSecret(masked[field] as string);
    }
  }

  return masked;
}

/**
 * Generate a pairing secret for modem-gateway providers.
 * Produces 6-8 case-insensitive alphanumeric characters.
 *
 * Requirements: 1.2
 */
function generatePairingSecret(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const length = 6 + (randomBytes(1)[0] % 3);
  const bytes = randomBytes(length);
  let secret = '';
  for (let i = 0; i < length; i++) {
    secret += chars[bytes[i] % chars.length];
  }
  return secret;
}

const providerIdParamSchema = z.object({
  id: z.string().uuid('Invalid provider ID format'),
});

const addProviderBodySchema = z.object({
  type: z.string().min(1, 'Provider type is required'),
  displayName: z.string().min(1, 'Display name is required').max(100, 'Display name must be 100 characters or fewer'),
  config: z.record(z.unknown()).default({}),
});

const updateProviderBodySchema = z.object({
  displayName: z.string().min(1, 'Display name is required').max(100, 'Display name must be 100 characters or fewer').optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

/**
 * Register provider management CRUD routes.
 *
 * All endpoints require session authentication (applied via session middleware
 * registered before these routes).
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */
export function registerProviderRoutes(
  server: FastifyInstance,
  registry: ProviderRegistry,
): void {
  /**
   * GET /api/provider-types
   * List available provider types for the "add provider" UI flow.
   * Excludes experimental types (e.g., "modem-gateway") unless the
   * EXPERIMENTAL_PROVIDERS environment variable is set to "true".
   *
   * Requirements: 17.1, 17.2, 17.3, 17.4
   */
  server.get('/api/provider-types', async (_request: FastifyRequest, reply: FastifyReply) => {
    const experimentalEnabled = process.env.EXPERIMENTAL_PROVIDERS === 'true';
    const EXPERIMENTAL_TYPES = ['modem-gateway'];

    let types = getSupportedProviderTypes();
    if (!experimentalEnabled) {
      types = types.filter((t) => !EXPERIMENTAL_TYPES.includes(t));
    }

    return reply.status(200).send({ types });
  });

  /**
   * GET /api/providers
   * List all registered providers with id, type, displayName, and enabled status.
   *
   * Requirements: 3.1
   */
  server.get('/api/providers', async (_request: FastifyRequest, reply: FastifyReply) => {
    const providers = registry.listProviders();

    return reply.status(200).send({
      providers: providers.map((p) => ({
        id: p.id,
        type: p.type,
        displayName: p.displayName,
        enabled: p.enabled,
      })),
    });
  });

  /**
   * POST /api/providers
   * Add a new provider. Validates config, persists, and returns id + webhook URLs.
   *
   * Requirements: 3.2, 3.5, 3.6
   */
  server.post('/api/providers', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = addProviderBodySchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        fieldErrors: parseResult.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'body',
          message: issue.message,
        })),
      });
    }

    const { type, displayName, config } = parseResult.data;

    try {
      // For modem-gateway providers, generate a pairing secret and store it in config
      const providerConfig = { ...config } as Record<string, unknown>;
      let pairingSecret: string | undefined;

      if (type === 'modem-gateway') {
        pairingSecret = generatePairingSecret();
        providerConfig.pairing_secret = pairingSecret;
        providerConfig.pairing_secret_created_at = new Date().toISOString();
      }

      const result = await registry.addProvider(type, displayName, providerConfig);

      // For modem-gateway, include pairing_secret and ws_endpoint in response
      if (type === 'modem-gateway' && pairingSecret) {
        return reply.status(201).send({
          providerId: result.providerId,
          webhookUrls: result.webhookUrls,
          pairingSecret,
          wsEndpoint: `/ws/providers/${result.providerId}/signaling`,
        });
      }

      return reply.status(201).send({
        providerId: result.providerId,
        webhookUrls: result.webhookUrls,
      });
    } catch (err) {
      if (err instanceof ProviderValidationError) {
        return reply.status(400).send({
          error: err.message,
          fieldErrors: err.errors,
        });
      }
      throw err;
    }
  });

  /**
   * GET /api/providers/:id
   * Get provider details with masked secrets in config.
   *
   * Requirements: 3.3
   */
  server.get('/api/providers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const paramResult = providerIdParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({
        error: 'Invalid provider ID format',
        fieldErrors: paramResult.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'id',
          message: issue.message,
        })),
      });
    }

    const { id } = paramResult.data;
    const provider = registry.getProvider(id);

    if (!provider) {
      return reply.status(404).send({
        error: `Provider ${id} not found`,
      });
    }

    const webhookUrls = registry.getWebhookUrls(id);

    return reply.status(200).send({
      id: provider.id,
      type: provider.type,
      displayName: provider.displayName,
      config: maskConfig(provider.type, provider.config),
      enabled: provider.enabled,
      webhookUrls,
    });
  });

  /**
   * PUT /api/providers/:id
   * Update a provider's display name, config, or enabled status.
   *
   * Requirements: 3.3, 3.4
   */
  server.put('/api/providers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const paramResult = providerIdParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({
        error: 'Invalid provider ID format',
        fieldErrors: paramResult.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'id',
          message: issue.message,
        })),
      });
    }

    const { id } = paramResult.data;

    const bodyResult = updateProviderBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        fieldErrors: bodyResult.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'body',
          message: issue.message,
        })),
      });
    }

    const updates = bodyResult.data;

    try {
      await registry.updateProvider(id, updates as Partial<{
        displayName: string;
        config: Record<string, unknown>;
        enabled: boolean;
      }>);

      // Fetch updated provider to return current state
      const provider = registry.getProvider(id);
      if (!provider) {
        return reply.status(404).send({
          error: `Provider ${id} not found`,
        });
      }

      const webhookUrls = registry.getWebhookUrls(id);

      return reply.status(200).send({
        id: provider.id,
        type: provider.type,
        displayName: provider.displayName,
        config: maskConfig(provider.type, provider.config),
        enabled: provider.enabled,
        webhookUrls,
      });
    } catch (err) {
      if (err instanceof ProviderNotFoundError) {
        return reply.status(404).send({
          error: err.message,
        });
      }
      if (err instanceof ProviderValidationError) {
        return reply.status(400).send({
          error: err.message,
          fieldErrors: err.errors,
        });
      }
      throw err;
    }
  });

  /**
   * DELETE /api/providers/:id
   * Remove a provider. Rejects if numbers are assigned or active calls exist.
   *
   * Requirements: 3.7, 3.8
   */
  server.delete('/api/providers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const paramResult = providerIdParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({
        error: 'Invalid provider ID format',
        fieldErrors: paramResult.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'id',
          message: issue.message,
        })),
      });
    }

    const { id } = paramResult.data;

    try {
      await registry.removeProvider(id);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof ProviderNotFoundError) {
        return reply.status(404).send({
          error: err.message,
        });
      }
      if (err instanceof ProviderRemovalBlockedError) {
        return reply.status(409).send({
          error: err.message,
          reason: err.reason,
        });
      }
      throw err;
    }
  });

  /**
   * POST /api/providers/:id/reset
   * Reset a modem-gateway provider's pairing: close WS, delete stored key,
   * generate new pairing secret.
   *
   * Requirements: 2.6
   */
  server.post('/api/providers/:id/reset', async (request: FastifyRequest, reply: FastifyReply) => {
    const paramResult = providerIdParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({
        error: 'Invalid provider ID format',
        fieldErrors: paramResult.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'id',
          message: issue.message,
        })),
      });
    }

    const { id } = paramResult.data;
    const provider = registry.getProvider(id);

    if (!provider) {
      return reply.status(404).send({
        error: `Provider ${id} not found`,
      });
    }

    if (provider.type !== 'modem-gateway') {
      return reply.status(400).send({
        error: 'Reset is only supported for modem-gateway providers',
      });
    }

    const instance = provider.instance as ModemGatewayTelephonyProvider | null;
    const wsHandler = instance?.getWsHandler();

    let newSecret: string;

    if (wsHandler) {
      // Use the WS handler's resetPairing which closes connection, deletes key, generates new secret
      newSecret = await wsHandler.resetPairing();
    } else {
      // No WS handler yet (not connected) — just generate a new secret in config
      newSecret = generatePairingSecret();
    }

    // Update the provider config with the new secret
    await registry.updateProvider(id, {
      config: {
        ...provider.config,
        pairing_secret: newSecret,
        pairing_secret_created_at: new Date().toISOString(),
        public_key: null, // Clear stored public key
      },
    });

    return reply.status(200).send({
      pairingSecret: newSecret,
      wsEndpoint: `/ws/providers/${id}/signaling`,
    });
  });

  /**
   * GET /api/providers/:id/status
   * Get current modem status for a modem-gateway provider.
   * Returns signal strength, network registration, operator, modem info.
   *
   * Requirements: 9.3, 25.3, 30.6
   */
  server.get('/api/providers/:id/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const paramResult = providerIdParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({
        error: 'Invalid provider ID format',
        fieldErrors: paramResult.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'id',
          message: issue.message,
        })),
      });
    }

    const { id } = paramResult.data;
    const provider = registry.getProvider(id);

    if (!provider) {
      return reply.status(404).send({
        error: `Provider ${id} not found`,
      });
    }

    if (provider.type !== 'modem-gateway') {
      return reply.status(400).send({
        error: 'Status endpoint is only supported for modem-gateway providers',
      });
    }

    const instance = provider.instance as ModemGatewayTelephonyProvider | null;

    if (!instance) {
      return reply.status(200).send({
        connected: false,
        signal: null,
        network: null,
        operator: null,
        modemModel: null,
        modemManufacturer: null,
        firmware: null,
        modemUnsupportedWarning: null,
      });
    }

    const status = instance.getModemStatus();
    const wsHandler = instance.getWsHandler();
    const connected = wsHandler?.isConnected() ?? false;

    if (!status) {
      return reply.status(200).send({
        connected,
        signal: null,
        network: null,
        operator: null,
        modemModel: null,
        modemManufacturer: null,
        firmware: null,
        modemUnsupportedWarning: null,
      });
    }

    return reply.status(200).send({
      connected,
      signal: status.signal,
      network: status.network,
      operator: status.operator,
      modemModel: status.modemModel ?? null,
      modemManufacturer: status.modemManufacturer ?? null,
      firmware: status.firmware ?? null,
      stale: status.stale ?? null,
      modemUnsupportedWarning: status.modemUnsupportedWarning ?? null,
    });
  });
}
