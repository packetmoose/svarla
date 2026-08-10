import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import type { ProviderRegistry, ProviderRegistryEntry, ProviderLogger } from './provider-registry.js';
import { validateLabel } from '../validators/label-validator.js';

/**
 * Color palette for provider numbers.
 * These colors are designed to work with the app's purple/teal Material 3 theme.
 */
const NUMBER_COLOR_PALETTE = [
  '#6750A4', // purple (primary)
  '#006B5F', // teal
  '#B5485E', // rose
  '#526E2D', // olive
  '#7C5635', // brown
  '#00658E', // blue
  '#8B4F8A', // mauve
  '#5D5F30', // moss
];

export interface NumberRecord {
  number: string;
  provider_id: string | null;
  provider_display_name?: string;
  label: string | null;
  color: string;
  added_at: Date;
  is_active: boolean;
  last_used_at: Date | null;
  block_inbound_calls: boolean;
}

export interface SyncResult {
  added: string[];
  removed: string[];
  total: number;
}

export type BroadcastCallback = (event: NumberEvent) => void;

export type NumberEvent =
  | { type: 'numbers_changed'; numbers: NumberRecord[]; added: string[]; removed: string[] }
  | { type: 'number_label_updated'; number: string; label: string }
  | { type: 'number_block_inbound_updated'; number: string; blockInboundCalls: boolean };

/**
 * Error thrown when an operation targets a number whose provider is unavailable or disabled.
 */
export class ProviderUnavailableError extends Error {
  readonly providerId: string;

  constructor(providerId: string, message?: string) {
    super(message ?? `Provider ${providerId} is not available`);
    this.name = 'ProviderUnavailableError';
    this.providerId = providerId;
  }
}

/**
 * NumberManagementService manages numbers:
 * - Syncs numbers from providers via ProviderRegistry
 * - Manages labels in the database
 * - Selects default numbers for outbound operations
 * - Routes operations through the owning provider
 * - Broadcasts changes via a callback (for WebSocket delivery)
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */
export class NumberManagementService {
  private readonly db: Kysely<Database>;
  private readonly registry: ProviderRegistry;
  private readonly broadcast: BroadcastCallback;
  private readonly logger: ProviderLogger;

  constructor(
    db: Kysely<Database>,
    registry: ProviderRegistry,
    broadcast: BroadcastCallback,
    logger?: ProviderLogger
  ) {
    this.db = db;
    this.registry = registry;
    this.broadcast = broadcast;
    this.logger = logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  }

  /**
   * Sync numbers from a specific provider.
   * Detects additions (marks new numbers active) and removals (marks missing numbers inactive).
   * Sets provider_id on newly inserted numbers.
   *
   * Requirements: 4.1
   */
  async syncNumbers(providerId: string): Promise<SyncResult> {
    this.logger.debug(`syncNumbers called for provider ${providerId}`);

    const entry = this.registry.getProvider(providerId);
    if (!entry) {
      throw new Error(`Provider ${providerId} not found in registry`);
    }
    if (!entry.instance) {
      throw new ProviderUnavailableError(providerId, `Provider ${providerId} is not available (status: ${entry.status})`);
    }

    this.logger.debug(`Fetching numbers from provider "${entry.displayName}" (${providerId}, type=${entry.type})`);
    const providerNumbers = await entry.instance.listNumbers();
    this.logger.debug(`Provider returned ${providerNumbers.length} number(s): [${providerNumbers.map((n) => n.number).join(', ')}]`);

    const providerNumberSet = new Set(providerNumbers.map((n) => n.number));

    // Get all numbers currently in DB for this provider
    const dbNumbers = await this.db
      .selectFrom('numbers')
      .selectAll()
      .where('provider_id', '=', providerId)
      .execute();

    this.logger.debug(`Database has ${dbNumbers.length} number(s) for provider ${providerId}`);

    const dbNumberMap = new Map(dbNumbers.map((n) => [n.number, n]));

    const added: string[] = [];
    const removed: string[] = [];

    // Find new numbers (in provider but not in DB, or in DB but inactive)
    for (const providerNum of providerNumbers) {
      const existing = dbNumberMap.get(providerNum.number);
      if (!existing) {
        // Pick a color based on current total count
        const totalCount = dbNumbers.length + added.length;
        const color = NUMBER_COLOR_PALETTE[totalCount % NUMBER_COLOR_PALETTE.length];

        this.logger.debug(`New number discovered: ${providerNum.number} — upserting with color ${color}`);

        // Insert or update — the number may exist under a different (deleted) provider
        await this.db
          .insertInto('numbers')
          .values({
            number: providerNum.number,
            provider_id: providerId,
            label: null,
            color,
            is_active: true,
            last_used_at: null,
          })
          .onConflict((oc) =>
            oc.column('number').doUpdateSet({
              provider_id: providerId,
              is_active: true,
            })
          )
          .execute();
        added.push(providerNum.number);
      } else if (!existing.is_active) {
        this.logger.debug(`Re-activating previously removed number: ${providerNum.number}`);
        // Was previously removed, now re-added
        await this.db
          .updateTable('numbers')
          .set({ is_active: true })
          .where('number', '=', providerNum.number)
          .execute();
        added.push(providerNum.number);
      }
    }

    // Find removed numbers (in DB and active, but not in provider)
    // Orphan them the same way as provider deletion: deactivate, detach, clear label.
    // This hides them from the settings UI (INNER JOIN on providers excludes NULL provider_id)
    // while preserving them for historical reference in messages and call_history.
    for (const dbNum of dbNumbers) {
      if (dbNum.is_active && !providerNumberSet.has(dbNum.number)) {
        this.logger.debug(`Number no longer in provider, orphaning: ${dbNum.number}`);
        await this.db
          .updateTable('numbers')
          .set({
            is_active: false,
            provider_id: null,
            label: null,
          })
          .where('number', '=', dbNum.number)
          .execute();
        removed.push(dbNum.number);
      }
    }

    // If changes occurred, broadcast
    if (added.length > 0 || removed.length > 0) {
      this.logger.debug(`Sync changes: added=[${added.join(', ')}] removed=[${removed.join(', ')}] — broadcasting`);
      const updatedNumbers = await this.getNumbers();
      this.broadcast({
        type: 'numbers_changed',
        numbers: updatedNumbers,
        added,
        removed,
      });
    } else {
      this.logger.debug(`Sync complete for provider ${providerId}: no changes detected`);
    }

    const activeCount = providerNumbers.length;
    return { added, removed, total: activeCount };
  }

  /**
   * Get all active numbers with provider context (provider_id and display_name via JOIN).
   * Sorted by last_used_at desc (most recently used first).
   * Numbers that have never been used (last_used_at is null) sort last.
   *
   * Requirements: 4.4
   */
  async getNumbers(): Promise<NumberRecord[]> {
    const numbers = await this.db
      .selectFrom('numbers')
      .innerJoin('providers', 'providers.id', 'numbers.provider_id')
      .select([
        'numbers.number',
        'numbers.provider_id',
        'numbers.label',
        'numbers.color',
        'numbers.is_active',
        'numbers.added_at',
        'numbers.last_used_at',
        'numbers.block_inbound_calls',
        'providers.display_name as provider_display_name',
      ])
      .where('numbers.is_active', '=', true)
      .orderBy('numbers.last_used_at', 'desc')
      .execute();

    return numbers.map((n) => ({
      number: n.number,
      provider_id: n.provider_id,
      provider_display_name: n.provider_display_name,
      label: n.label,
      color: n.color,
      added_at: n.added_at,
      is_active: n.is_active,
      last_used_at: n.last_used_at,
      block_inbound_calls: n.block_inbound_calls,
    }));
  }

  /**
   * Get all numbers (including inactive) for management UI.
   * Orphaned numbers (provider_id IS NULL, from removed providers) are excluded
   * by the INNER JOIN — they are retained only for historical reference in
   * messages and call_history.
   * Requirements: 9.1
   */
  async getAllNumbers(): Promise<NumberRecord[]> {
    const numbers = await this.db
      .selectFrom('numbers')
      .innerJoin('providers', 'providers.id', 'numbers.provider_id')
      .select([
        'numbers.number',
        'numbers.provider_id',
        'numbers.label',
        'numbers.color',
        'numbers.is_active',
        'numbers.added_at',
        'numbers.last_used_at',
        'numbers.block_inbound_calls',
        'providers.display_name as provider_display_name',
      ])
      .orderBy('providers.display_name', 'asc')
      .orderBy('numbers.number', 'asc')
      .execute();

    return numbers.map((n) => ({
      number: n.number,
      provider_id: n.provider_id,
      provider_display_name: n.provider_display_name,
      label: n.label,
      color: n.color,
      added_at: n.added_at,
      is_active: n.is_active,
      last_used_at: n.last_used_at,
      block_inbound_calls: n.block_inbound_calls,
    }));
  }

  /**
   * Update the label for a number.
   * Validates label length (1-30 chars) using label-validator.
   */
  async updateLabel(
    number: string,
    label: string
  ): Promise<{ success: boolean; error?: string }> {
    const validation = validateLabel(label);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const result = await this.db
      .updateTable('numbers')
      .set({ label })
      .where('number', '=', number)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if ((result?.numUpdatedRows ?? 0n) === 0n) {
      return { success: false, error: 'Number not found or inactive' };
    }

    this.broadcast({
      type: 'number_label_updated',
      number,
      label,
    });

    return { success: true };
  }

  /**
   * Get the provider entry for a given phone number.
   * Looks up the number's provider_id, then retrieves the provider from the registry.
   *
   * Requirements: 4.2, 4.3
   */
  async getProviderForNumber(number: string): Promise<ProviderRegistryEntry | null> {
    const row = await this.db
      .selectFrom('numbers')
      .select('provider_id')
      .where('number', '=', number)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    if (!row.provider_id) {
      return null;
    }

    return this.registry.getProvider(row.provider_id) ?? null;
  }

  /**
   * Ensure the provider for a number is available for operations.
   * Throws ProviderUnavailableError if the provider is disabled or unavailable.
   *
   * Requirements: 4.5
   */
  async requireProviderForNumber(number: string): Promise<ProviderRegistryEntry> {
    const entry = await this.getProviderForNumber(number);
    if (!entry) {
      throw new Error(`No provider found for number ${number}`);
    }

    if (entry.status === 'disabled') {
      throw new ProviderUnavailableError(
        entry.id,
        `Provider "${entry.displayName}" (${entry.id}) is disabled`
      );
    }

    if (entry.status === 'unavailable' || !entry.instance) {
      throw new ProviderUnavailableError(
        entry.id,
        `Provider "${entry.displayName}" (${entry.id}) is unavailable`
      );
    }

    return entry;
  }

  /**
   * Get the default number for outbound operations.
   * Logic:
   * - If a user-set default number exists (in settings) and is still active, use it
   * - If only one active number exists, return it (auto-select)
   * - Otherwise, return the most recently used number (highest last_used_at)
   * - If no numbers have been used, return the first number added
   */
  async getDefaultNumber(): Promise<NumberRecord | null> {
    const numbers = await this.db
      .selectFrom('numbers')
      .innerJoin('providers', 'providers.id', 'numbers.provider_id')
      .select([
        'numbers.number',
        'numbers.provider_id',
        'numbers.label',
        'numbers.color',
        'numbers.is_active',
        'numbers.added_at',
        'numbers.last_used_at',
        'numbers.block_inbound_calls',
        'providers.display_name as provider_display_name',
      ])
      .where('numbers.is_active', '=', true)
      .execute();

    if (numbers.length === 0) {
      return null;
    }

    // Check if user has explicitly set a default number
    const setting = await this.db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'default_number')
      .executeTakeFirst();

    if (setting?.value) {
      const userDefault = numbers.find((n) => n.number === setting.value);
      if (userDefault) {
        return {
          number: userDefault.number,
          provider_id: userDefault.provider_id,
          provider_display_name: userDefault.provider_display_name,
          label: userDefault.label,
          color: userDefault.color,
          added_at: userDefault.added_at,
          is_active: userDefault.is_active,
          last_used_at: userDefault.last_used_at,
          block_inbound_calls: userDefault.block_inbound_calls,
        };
      }
    }

    // Auto-select when only one number
    if (numbers.length === 1) {
      const n = numbers[0];
      return {
        number: n.number,
        provider_id: n.provider_id,
        provider_display_name: n.provider_display_name,
        label: n.label,
        color: n.color,
        added_at: n.added_at,
        is_active: n.is_active,
        last_used_at: n.last_used_at,
        block_inbound_calls: n.block_inbound_calls,
      };
    }

    // Find most recently used
    const usedNumbers = numbers.filter((n) => n.last_used_at !== null);
    if (usedNumbers.length > 0) {
      usedNumbers.sort(
        (a, b) => new Date(b.last_used_at!).getTime() - new Date(a.last_used_at!).getTime()
      );
      const n = usedNumbers[0];
      return {
        number: n.number,
        provider_id: n.provider_id,
        provider_display_name: n.provider_display_name,
        label: n.label,
        color: n.color,
        added_at: n.added_at,
        is_active: n.is_active,
        last_used_at: n.last_used_at,
        block_inbound_calls: n.block_inbound_calls,
      };
    }

    // No numbers used yet — return the first one added
    numbers.sort(
      (a, b) => new Date(a.added_at).getTime() - new Date(b.added_at).getTime()
    );
    const n = numbers[0];
    return {
      number: n.number,
      provider_id: n.provider_id,
      provider_display_name: n.provider_display_name,
      label: n.label,
      color: n.color,
      added_at: n.added_at,
      is_active: n.is_active,
      last_used_at: n.last_used_at,
      block_inbound_calls: n.block_inbound_calls,
    };
  }

  /**
   * Set the user's preferred default number for outbound calls and SMS.
   * Pass null to clear the preference and revert to automatic selection.
   */
  async setDefaultNumber(
    number: string | null
  ): Promise<{ success: boolean; error?: string }> {
    // Validate that the number exists and is active (if not clearing)
    if (number !== null) {
      const exists = await this.db
        .selectFrom('numbers')
        .select('number')
        .where('number', '=', number)
        .where('is_active', '=', true)
        .executeTakeFirst();

      if (!exists) {
        return { success: false, error: 'Number not found or inactive' };
      }
    }

    await this.db
      .insertInto('settings')
      .values({
        key: 'default_number',
        value: number,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value: number,
          updated_at: new Date(),
        })
      )
      .execute();

    return { success: true };
  }

  /**
   * Activate or deactivate a number.
   * Requirements: 9.4
   */
  async setActive(
    number: string,
    active: boolean
  ): Promise<{ success: boolean; error?: string }> {
    const result = await this.db
      .updateTable('numbers')
      .set({ is_active: active })
      .where('number', '=', number)
      .executeTakeFirst();

    if ((result?.numUpdatedRows ?? 0n) === 0n) {
      return { success: false, error: 'Number not found' };
    }

    // Broadcast the change
    const numbers = await this.getNumbers();
    this.broadcast({
      type: 'numbers_changed',
      numbers,
      added: [],
      removed: [],
    });

    return { success: true };
  }

  /**
   * Mark a number as used (updates last_used_at to now).
   * Called when a number is used for an outbound call or SMS.
   */
  async markNumberUsed(number: string): Promise<boolean> {
    const result = await this.db
      .updateTable('numbers')
      .set({ last_used_at: new Date() })
      .where('number', '=', number)
      .where('is_active', '=', true)
      .executeTakeFirst();

    return (result?.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Set the block_inbound_calls flag for a number.
   * When enabled, inbound calls to this number will hear a message
   * telling them to send a text message instead.
   */
  async setBlockInboundCalls(
    number: string,
    block: boolean
  ): Promise<{ success: boolean; error?: string }> {
    const result = await this.db
      .updateTable('numbers')
      .set({ block_inbound_calls: block })
      .where('number', '=', number)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if ((result?.numUpdatedRows ?? 0n) === 0n) {
      return { success: false, error: 'Number not found or inactive' };
    }

    this.broadcast({
      type: 'number_block_inbound_updated',
      number,
      blockInboundCalls: block,
    });

    return { success: true };
  }

  /**
   * Check if inbound calls are blocked for a given number.
   * Used by the webhook router to determine if an inbound call should be rejected
   * with a voice message.
   */
  async isInboundBlocked(number: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('numbers')
      .select('block_inbound_calls')
      .where('number', '=', number)
      .where('is_active', '=', true)
      .executeTakeFirst();

    return row?.block_inbound_calls ?? false;
  }
}
