import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import type { TelephonyProvider } from '../providers/telephony-provider.js';
import { validateProviderConfig } from '../validators/provider-config-validator.js';
import { encryptConfig, decryptConfig } from './config-encryption.js';

/**
 * Represents a provider entry in the in-memory registry.
 */
export interface ProviderRegistryEntry {
  id: string;
  type: string;
  displayName: string;
  config: Record<string, unknown>;
  enabled: boolean;
  instance: TelephonyProvider | null;
  status: 'active' | 'unavailable' | 'disabled';
}

/**
 * Logger interface used by ProviderRegistry.
 * Compatible with Pino/Fastify logger.
 */
export interface ProviderLogger {
  debug(msg: string): void;
  debug(obj: unknown, msg: string): void;
  info(msg: string): void;
  info(obj: unknown, msg: string): void;
  warn(msg: string): void;
  warn(obj: unknown, msg: string): void;
  error(msg: string): void;
  error(obj: unknown, msg: string): void;
}

/**
 * Factory function type for creating TelephonyProvider instances from config.
 */
export type ProviderFactory = (
  type: string,
  config: Record<string, unknown>,
) => TelephonyProvider;

/**
 * Static map of provider type to webhook endpoint suffixes.
 * Used until TelephonyProvider.getWebhookEndpoints() is added (task 6.1).
 */
const WEBHOOK_ENDPOINTS: Record<string, string[]> = {
  vonage: ['answer', 'event', 'inbound-sms', 'sms-status'],
  '46elks': ['voice_start', 'voice_event', 'sms_incoming'],
  dummy: ['inbound-sms', 'event'],
  'modem-gateway': [],
};

/**
 * ProviderRegistry manages all active telephony provider instances.
 *
 * It replaces the single-provider createTelephonyProvider() factory with
 * a database-backed, runtime-manageable registry of multiple provider instances.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderRegistryEntry>();
  private readonly db: Kysely<Database>;
  private readonly webhookBaseUrl: string;
  private readonly logger: ProviderLogger;
  private readonly factory: ProviderFactory;
  private readonly encryptionKey: string | undefined;

  constructor(
    db: Kysely<Database>,
    webhookBaseUrl: string,
    logger: ProviderLogger,
    factory: ProviderFactory,
    encryptionKey?: string,
  ) {
    this.db = db;
    this.webhookBaseUrl = webhookBaseUrl;
    this.logger = logger;
    this.factory = factory;
    this.encryptionKey = encryptionKey || undefined;
  }

  /**
   * Load all enabled providers from the database and initialize each one.
   * Initialization failures are handled gracefully: the provider is marked
   * as unavailable, logged, and the remaining providers continue loading.
   *
   * Requirements: 1.3, 1.4
   */
  async loadAll(): Promise<void> {
    this.logger.debug('Loading all enabled providers from database');

    const rows = await this.db
      .selectFrom('providers')
      .selectAll()
      .where('enabled', '=', true)
      .execute();

    this.logger.debug(`Found ${rows.length} enabled provider(s) to load`);

    for (const row of rows) {
      this.logger.debug(`Loading provider: type=${row.type} name="${row.display_name}" id=${row.id}`);

      const rawConfig = (row.config as Record<string, unknown>) ?? {};
      // Decrypt sensitive fields if encryption key is available
      const config = decryptConfig(row.type, rawConfig, this.encryptionKey);

      this.logger.debug(`Decrypted config for provider ${row.id}, keys: [${Object.keys(config).join(', ')}]`);

      const entry: ProviderRegistryEntry = {
        id: row.id,
        type: row.type,
        displayName: row.display_name,
        config,
        enabled: row.enabled,
        instance: null,
        status: 'unavailable',
      };

      try {
        this.logger.debug(`Creating instance for provider ${row.id} via factory (type=${row.type})`);
        const instance = this.factory(row.type, { ...config, _registryId: row.id });

        this.logger.debug(`Starting provider instance ${row.id}`);
        await instance.start();

        entry.instance = instance;
        entry.status = 'active';
        this.logger.info(`Provider ${row.display_name} (${row.id}) initialized successfully`);
      } catch (err) {
        entry.status = 'unavailable';
        this.logger.error(err, `Failed to initialize provider ${row.display_name} (${row.id})`);
      }

      this.providers.set(row.id, entry);
    }

    this.logger.debug(`Provider loading complete. ${this.providers.size} provider(s) in registry`);
  }

  /**
   * Look up a provider by its ID.
   *
   * Requirements: 1.2
   */
  getProvider(providerId: string): ProviderRegistryEntry | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Return all registered provider entries (active, unavailable, and disabled).
   *
   * Requirements: 3.1
   */
  listProviders(): ProviderRegistryEntry[] {
    return Array.from(this.providers.values());
  }

  /**
   * Register a new provider: validate config, persist to DB, initialize instance,
   * and return the provider ID and webhook URLs.
   *
   * Requirements: 1.1, 1.2, 3.2, 3.5, 3.6
   */
  async addProvider(
    type: string,
    displayName: string,
    config: Record<string, unknown>,
  ): Promise<{ providerId: string; webhookUrls: string[] }> {
    this.logger.debug(`addProvider called: type=${type} displayName="${displayName}" configKeys=[${Object.keys(config).join(', ')}]`);

    // Validate config for the given type
    const validation = validateProviderConfig(type, config);
    if (!validation.valid) {
      const fieldErrors = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      this.logger.debug(`Provider config validation failed: ${fieldErrors}`);
      throw new ProviderValidationError(
        `Invalid configuration for provider type "${type}": ${fieldErrors}`,
        validation.errors,
      );
    }

    this.logger.debug(`Provider config validation passed for type=${type}`);

    // Generate a new UUID for the provider
    const providerId = randomUUID();
    this.logger.debug(`Generated provider ID: ${providerId}`);

    // Encrypt sensitive fields before persisting
    const encryptedConfig = encryptConfig(type, config, this.encryptionKey);

    // Persist to database
    this.logger.debug(`Persisting provider ${providerId} to database`);
    await this.db
      .insertInto('providers')
      .values({
        id: providerId,
        type,
        display_name: displayName,
        config: JSON.stringify(encryptedConfig),
        enabled: true,
      })
      .execute();

    this.logger.debug(`Provider ${providerId} persisted successfully`);

    // Initialize provider instance
    const entry: ProviderRegistryEntry = {
      id: providerId,
      type,
      displayName,
      config,
      enabled: true,
      instance: null,
      status: 'unavailable',
    };

    try {
      this.logger.debug(`Creating instance for new provider ${providerId} via factory (type=${type})`);
      const instance = this.factory(type, { ...config, _registryId: providerId });

      this.logger.debug(`Starting new provider instance ${providerId}`);
      await instance.start();

      entry.instance = instance;
      entry.status = 'active';
      this.logger.info(`Provider ${displayName} (${providerId}) added and initialized`);
    } catch (err) {
      entry.status = 'unavailable';
      this.logger.error(err, `Provider ${displayName} (${providerId}) added but failed to initialize`);
    }

    this.providers.set(providerId, entry);

    const webhookUrls = this.getWebhookUrls(providerId);
    this.logger.debug(`Provider ${providerId} webhook URLs: [${webhookUrls.join(', ')}]`);
    return { providerId, webhookUrls };
  }

  /**
   * Update a provider's display name, config, or enabled status.
   * If config or enabled changes, reinitialize the provider instance.
   *
   * Requirements: 3.3, 3.4
   */
  async updateProvider(
    providerId: string,
    updates: Partial<{
      displayName: string;
      config: Record<string, unknown>;
      enabled: boolean;
    }>,
  ): Promise<void> {
    const entry = this.providers.get(providerId);
    if (!entry) {
      throw new ProviderNotFoundError(`Provider ${providerId} not found`);
    }

    // If config is being updated, merge with existing config (so omitted fields keep current values)
    // then validate the merged result.
    let mergedConfig: Record<string, unknown> | undefined;
    if (updates.config !== undefined) {
      mergedConfig = { ...entry.config, ...updates.config };
      const validation = validateProviderConfig(entry.type, mergedConfig);
      if (!validation.valid) {
        const fieldErrors = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
        throw new ProviderValidationError(
          `Invalid configuration for provider type "${entry.type}": ${fieldErrors}`,
          validation.errors,
        );
      }
    }

    // Build database update payload
    const dbUpdates: Record<string, unknown> = { updated_at: new Date() };
    if (updates.displayName !== undefined) {
      dbUpdates.display_name = updates.displayName;
    }
    if (mergedConfig !== undefined) {
      // Encrypt sensitive fields before persisting
      const encryptedConfig = encryptConfig(entry.type, mergedConfig, this.encryptionKey);
      dbUpdates.config = JSON.stringify(encryptedConfig);
    }
    if (updates.enabled !== undefined) {
      dbUpdates.enabled = updates.enabled;
    }

    await this.db
      .updateTable('providers')
      .set(dbUpdates)
      .where('id', '=', providerId)
      .execute();

    // Apply updates to in-memory entry
    if (updates.displayName !== undefined) {
      entry.displayName = updates.displayName;
    }
    if (mergedConfig !== undefined) {
      entry.config = mergedConfig;
    }
    if (updates.enabled !== undefined) {
      entry.enabled = updates.enabled;
    }

    // Reinitialize if config or enabled status changed
    const needsReinit = mergedConfig !== undefined || updates.enabled !== undefined;
    if (needsReinit) {
      // Stop existing instance if running
      if (entry.instance) {
        try {
          await entry.instance.stop();
        } catch (err) {
          this.logger.warn(err, `Failed to stop provider ${providerId} during update`);
        }
        entry.instance = null;
      }

      if (entry.enabled) {
        // Reinitialize
        try {
          const instance = this.factory(entry.type, { ...entry.config, _registryId: providerId });
          await instance.start();
          entry.instance = instance;
          entry.status = 'active';
          this.logger.info(`Provider ${entry.displayName} (${providerId}) reinitialized`);
        } catch (err) {
          entry.status = 'unavailable';
          this.logger.error(err, `Failed to reinitialize provider ${entry.displayName} (${providerId})`);
        }
      } else {
        entry.status = 'disabled';
      }
    }
  }

  /**
   * Remove a provider from the registry and database.
   * Orphans any associated numbers (deactivates, detaches, clears label)
   * so they remain for historical reference but are hidden from the UI.
   *
   * Requirements: 1.5, 3.7, 3.8
   */
  async removeProvider(providerId: string): Promise<void> {
    const entry = this.providers.get(providerId);
    if (!entry) {
      throw new ProviderNotFoundError(`Provider ${providerId} not found`);
    }

    // Orphan all numbers belonging to this provider:
    // deactivate, detach from provider, and clear label
    await this.db
      .updateTable('numbers')
      .set({
        is_active: false,
        provider_id: null,
        label: null,
      })
      .where('provider_id', '=', providerId)
      .execute();

    // Stop instance if running
    if (entry.instance) {
      try {
        await entry.instance.stop();
      } catch (err) {
        this.logger.warn(err, `Failed to stop provider ${providerId} during removal`);
      }
    }

    // Delete from database
    await this.db
      .deleteFrom('providers')
      .where('id', '=', providerId)
      .execute();

    // Remove from in-memory map
    this.providers.delete(providerId);

    this.logger.info(`Provider ${entry.displayName} (${providerId}) removed`);
  }

  /**
   * Construct webhook URLs for a provider based on its type.
   * URLs follow the pattern: {baseUrl}/webhooks/{providerId}/{endpoint}
   *
   * Uses the provider instance's getWebhookEndpoints() method when available,
   * falling back to the static WEBHOOK_ENDPOINTS map.
   *
   * Requirements: 2.1, 2.5
   */
  getWebhookUrls(providerId: string): string[] {
    const entry = this.providers.get(providerId);
    if (!entry) {
      return [];
    }

    const endpoints = entry.instance
      ? entry.instance.getWebhookEndpoints()
      : (WEBHOOK_ENDPOINTS[entry.type] ?? []);
    const base = this.webhookBaseUrl.replace(/\/$/, '');

    return endpoints.map((endpoint) => `${base}/webhooks/${providerId}/${endpoint}`);
  }
}

/**
 * Error thrown when provider configuration validation fails.
 */
export class ProviderValidationError extends Error {
  readonly errors: Array<{ field: string; message: string }>;

  constructor(message: string, errors: Array<{ field: string; message: string }>) {
    super(message);
    this.name = 'ProviderValidationError';
    this.errors = errors;
  }
}

/**
 * Error thrown when a provider is not found.
 */
export class ProviderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotFoundError';
  }
}

/**
 * Error thrown when provider removal is blocked.
 */
export class ProviderRemovalBlockedError extends Error {
  readonly reason: 'numbers_assigned' | 'active_users';

  constructor(message: string, reason: 'numbers_assigned' | 'active_users') {
    super(message);
    this.name = 'ProviderRemovalBlockedError';
    this.reason = reason;
  }
}
