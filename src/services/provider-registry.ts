import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import type { TelephonyProvider, ProviderHealth } from '../providers/telephony-provider.js';
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
  /**
   * Latest live health-check result for providers that implement checkHealth().
   * Absent/`null` means no check has run yet (or the provider does not support
   * health checks), which callers should treat as "not yet known" rather than
   * failed. The registry always initializes this to null for entries it creates.
   */
  health?: ProviderHealth | null;
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
 * Callback invoked whenever a provider instance becomes active — either when
 * a new provider is added, or when an existing provider is (re)initialized
 * after an update. Subscribers use this to attach runtime wiring (WebSocket
 * handlers, event listeners, number sync) that must not require a server
 * restart.
 */
export type ProviderActivatedListener = (entry: ProviderRegistryEntry) => void;

/**
 * Static map of provider type to webhook endpoint suffixes.
 * Used until TelephonyProvider.getWebhookEndpoints() is added (task 6.1).
 */
const WEBHOOK_ENDPOINTS: Record<string, string[]> = {
  vonage: ['answer', 'event', 'inbound-sms', 'sms-status'],
  // `voice_event` is not a statically-configured webhook — it is passed
  // per-call as `whenhangup`, so it is deliberately not listed here.
  '46elks': ['voice_start', 'sms_incoming'],
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
  private readonly activatedListeners: ProviderActivatedListener[] = [];
  private healthPollTimer: ReturnType<typeof setInterval> | null = null;

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
   * Register a listener that fires whenever a provider instance becomes active.
   *
   * The listener is invoked from {@link addProvider} (for newly created
   * providers) and from {@link updateProvider} (when a provider is
   * reinitialized after a config or enabled-status change). It is NOT invoked
   * from {@link loadAll}; startup wiring is driven by the caller iterating
   * {@link listProviders} so it can also run one-time startup-only work.
   *
   * This lets the server attach per-provider runtime wiring (e.g. the
   * modem-gateway WebSocket handler and event listeners) at creation time,
   * removing the need for a server restart before a new provider is usable.
   */
  onProviderActivated(listener: ProviderActivatedListener): void {
    this.activatedListeners.push(listener);
  }

  /**
   * Notify all activation listeners that a provider instance became active.
   * Listener failures are isolated so one bad listener cannot prevent others
   * (or the provider itself) from being wired up.
   */
  private emitProviderActivated(entry: ProviderRegistryEntry): void {
    for (const listener of this.activatedListeners) {
      try {
        listener(entry);
      } catch (err) {
        this.logger.error(err, `Provider activation listener failed for ${entry.displayName} (${entry.id})`);
      }
    }
    // Note: the immediate health check is awaited by addProvider/updateProvider
    // (see checkProviderHealth calls there) so their API responses reflect the
    // real, freshly-probed status rather than a stale value.
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
        health: null,
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
   * Return the latest cached health result for a provider, or null if unknown
   * (no check has run yet, or the provider does not support health checks).
   */
  getHealth(providerId: string): ProviderHealth | null {
    return this.providers.get(providerId)?.health ?? null;
  }

  /**
   * Run a single health check against one provider and cache the result on its
   * entry. No-op (leaves health as-is) if the provider is missing, has no active
   * instance, or its instance does not implement checkHealth(). Never throws —
   * an unexpected error is recorded as an unhealthy result.
   */
  async checkProviderHealth(providerId: string): Promise<void> {
    const entry = this.providers.get(providerId);
    if (!entry || !entry.instance || typeof entry.instance.checkHealth !== 'function') {
      return;
    }
    try {
      entry.health = await entry.instance.checkHealth();
      if (!entry.health.healthy) {
        this.logger.warn(
          `Provider ${entry.displayName} (${providerId}) health check failed: ${entry.health.reason ?? 'unknown'}`,
        );
      }
    } catch (err) {
      this.logger.error(err, `Health check threw for provider ${entry.displayName} (${providerId})`);
      entry.health = { healthy: false, reason: 'Health check error' };
    }
  }

  /**
   * Run health checks for all enabled, active providers that support them,
   * concurrently. Used on startup and by the periodic poller.
   *
   * Providers whose last check was an authentication failure are skipped: bad
   * credentials won't recover without a config change, and re-probing with
   * known-bad credentials wastes calls and risks provider-side rate limiting or
   * lockouts. Reconfiguring a provider reinitializes it and clears this state
   * (via updateProvider), and re-checks it immediately (via activation), so the
   * skip is lifted as soon as the user updates credentials.
   */
  async checkAllHealth(): Promise<void> {
    const targets = Array.from(this.providers.values()).filter(
      (e) =>
        e.enabled &&
        e.instance &&
        typeof e.instance.checkHealth === 'function' &&
        !(e.health && e.health.authFailure),
    );
    await Promise.all(targets.map((e) => this.checkProviderHealth(e.id)));
  }

  /**
   * Start periodic health polling. Runs an immediate check, then repeats every
   * `intervalMs`. Safe to call once; a second call is ignored while polling is
   * active. The interval timer is unref'd so it never keeps the process alive.
   */
  startHealthPolling(intervalMs: number): void {
    if (this.healthPollTimer) {
      return;
    }
    void this.checkAllHealth();
    this.healthPollTimer = setInterval(() => {
      void this.checkAllHealth();
    }, intervalMs);
    // Don't let the poll timer hold the event loop open (e.g. in tests / shutdown).
    if (typeof this.healthPollTimer.unref === 'function') {
      this.healthPollTimer.unref();
    }
  }

  /**
   * Stop periodic health polling and release the timer.
   */
  stopHealthPolling(): void {
    if (this.healthPollTimer) {
      clearInterval(this.healthPollTimer);
      this.healthPollTimer = null;
    }
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
      health: null,
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

    // Wire up runtime handlers for the freshly-activated provider so it is
    // usable immediately, without a server restart.
    if (entry.status === 'active' && entry.instance) {
      this.emitProviderActivated(entry);
      // Await the initial health check so the caller (and the API response)
      // reflects the real, freshly-probed status — e.g. surfacing invalid
      // credentials immediately rather than showing "ok" until the next poll.
      await this.checkProviderHealth(providerId);
    }

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
      // The instance (and thus its credentials) is being replaced, so any
      // previously cached health result is stale. Clear it; a fresh check runs
      // when the new instance is activated.
      entry.health = null;
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
          // Re-wire runtime handlers on the new instance. The previous instance
          // (and its handlers) was discarded when it was stopped above, so this
          // reattaches the WebSocket handler and event listeners.
          this.emitProviderActivated(entry);
          // Await the health check so the update response reflects the real
          // status of the new configuration (e.g. immediately flagging invalid
          // credentials the user just saved).
          await this.checkProviderHealth(providerId);
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
    // deactivate, detach from provider, and clear label. The color is preserved
    // so the number keeps it if re-added; it is only reclaimed later if the
    // palette runs out of colors for active numbers.
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

  /**
   * Build the full signaling WebSocket URL that a modem-gateway binary should
   * connect to, e.g. `wss://example.com/ws/providers/{id}/signaling`.
   *
   * The scheme is derived from the configured base URL (http → ws, https → wss),
   * mirroring how webhook URLs are built from the same base. When no base URL is
   * configured (e.g. local development), this falls back to the relative path so
   * the value is still usable rather than malformed.
   */
  getSignalingWsUrl(providerId: string): string {
    const path = `/ws/providers/${providerId}/signaling`;
    const base = this.webhookBaseUrl.replace(/\/$/, '');
    if (!base) {
      return path;
    }
    // http → ws, https → wss. Leaves already-ws(s) bases untouched.
    const wsBase = base.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
    return `${wsBase}${path}`;
  }

  /**
   * Build the MediaBridge audio WebSocket base URL that 46elks connects to for
   * call audio (its Realtime Voice API), e.g. `wss://example.com/audio/`.
   *
   * This is the URL a user registers against their 46elks WebSocket ("+4600…")
   * number in the 46elks dashboard. It is proxied to the MediaBridge audio
   * WebSocket (port 9091) behind TLS at the `/audio/` path — see the install
   * docs. The scheme is derived from the configured base URL (http → ws,
   * https → wss), matching how webhook and signaling URLs are built.
   *
   * Returns an empty string when no base URL is configured, since a relative
   * audio URL is not usable by an external provider.
   */
  getAudioWsUrl(): string {
    const base = this.webhookBaseUrl.replace(/\/$/, '');
    if (!base) {
      return '';
    }
    const wsBase = base.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
    return `${wsBase}/audio/`;
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
