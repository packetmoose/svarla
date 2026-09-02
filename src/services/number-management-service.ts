import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import type { ProviderRegistry, ProviderRegistryEntry, ProviderLogger } from './provider-registry.js';
import { validateLabel } from '../validators/label-validator.js';

/**
 * Color palette for provider numbers.
 *
 * Colors are mid-tone hues (roughly 45-60% lightness) chosen so they remain
 * legible as text on both light and dark surfaces AND read clearly as solid
 * fills. Both clients use the same hex as a foreground text color (web badge,
 * Android) and as a fill (web dot / translucent badge background), so overly
 * light or overly saturated values are avoided. Hues are spread around the
 * wheel to keep adjacent numbers visually distinct.
 *
 * Fallback color used by clients when a number has no color (inactive numbers
 * carry a null color). Keep in sync with the client fallbacks.
 */
export const NUMBER_COLOR_FALLBACK = '#6750A4';

export const NUMBER_COLOR_PALETTE = [
  '#6750A4', // purple
  '#006B5F', // teal
  '#B5485E', // rose
  '#526E2D', // olive
  '#7C5635', // brown
  '#00658E', // blue
  '#8B4F8A', // mauve
  '#5D5F30', // moss
  '#3F6C3A', // green
  '#9A4A2E', // terracotta
  '#455CC7', // indigo
  '#0A6E73', // deep cyan
  '#8A5A00', // amber
  '#A03E6E', // magenta
  '#4C6A8F', // slate blue
  '#7A5CA6', // violet
];

/**
/**
 * Result of choosing a color for a number being (re)activated.
 * `color` is the color to assign. If `reclaimFrom` is set, that color was
 * being held by an inactive number whose color must be cleared (set to null)
 * so the newly-activated number can hold it uniquely.
 */
export interface ColorChoice {
  color: string;
  reclaimFrom: string | null;
}

/**
 * Choose a color for a number that is being (re)activated.
 *
 * Colors persist for a number's lifetime; we only reclaim a color from an
 * inactive number when the palette is otherwise exhausted by active numbers.
 *
 * Priority:
 *  1. If the number already has a color that no OTHER active number uses, keep it.
 *  2. Otherwise use the first palette color held by neither an active nor an
 *     inactive number (a truly free color) — guarantees uniqueness.
 *  3. Otherwise, if some palette color is held only by inactive numbers, take
 *     it (reclaiming it from one inactive holder). Prefer the palette color
 *     with the fewest inactive holders so we disturb as few numbers as possible.
 *  4. Otherwise (every palette color is held by an active number), share the
 *     least-used color among active numbers, tie-broken by palette order.
 *
 * `existingColor` is the color the number currently holds (may be null).
 * `activeColors` / `inactiveColors` are the colors held by all other active
 * and inactive numbers respectively.
 */
export function chooseColor(
  existingColor: string | null,
  activeColors: readonly string[],
  inactiveColors: readonly string[]
): ColorChoice {
  const activeCounts = countPaletteColors(activeColors);
  const inactiveCounts = countPaletteColors(inactiveColors);

  // 1. Keep the existing color if no other active number uses it.
  if (
    existingColor &&
    NUMBER_COLOR_PALETTE.includes(existingColor) &&
    (activeCounts.get(existingColor) ?? 0) === 0
  ) {
    return { color: existingColor, reclaimFrom: null };
  }

  // 2. First palette color free of both active and inactive holders.
  for (const color of NUMBER_COLOR_PALETTE) {
    if ((activeCounts.get(color) ?? 0) === 0 && (inactiveCounts.get(color) ?? 0) === 0) {
      return { color, reclaimFrom: null };
    }
  }

  // 3. Palette color held only by inactive numbers — reclaim from inactive.
  //    Prefer the one with the fewest inactive holders.
  let reclaim: string | null = null;
  let reclaimCount = Infinity;
  for (const color of NUMBER_COLOR_PALETTE) {
    const inactive = inactiveCounts.get(color) ?? 0;
    if ((activeCounts.get(color) ?? 0) === 0 && inactive > 0 && inactive < reclaimCount) {
      reclaim = color;
      reclaimCount = inactive;
    }
  }
  if (reclaim) {
    return { color: reclaim, reclaimFrom: reclaim };
  }

  // 4. Every palette color is held by an active number: share the least-used.
  let best = NUMBER_COLOR_PALETTE[0];
  let bestCount = activeCounts.get(best) ?? 0;
  for (const color of NUMBER_COLOR_PALETTE) {
    const count = activeCounts.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return { color: best, reclaimFrom: null };
}

function countPaletteColors(colors: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const color of NUMBER_COLOR_PALETTE) counts.set(color, 0);
  for (const c of colors) {
    if (counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return counts;
}

export interface NumberRecord {
  number: string;
  provider_id: string | null;
  provider_display_name?: string;
  label: string | null;
  color: string | null;
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

    // Track colors held across ALL providers, split by active state, so we can
    // assign globally-unique colors while persisting each number's color for its
    // lifetime. We mutate these lists as we (re)activate numbers during this sync
    // so numbers processed in the same pass also stay distinct. Colors are
    // reclaimed from inactive numbers only when the palette is exhausted by
    // active numbers (see chooseColor).
    const usage = await this.getColorUsage();
    const activeColors = usage.active;
    const inactiveColors = usage.inactive;

    const added: string[] = [];
    const removed: string[] = [];

    // Find new numbers (in provider but not in DB, or in DB but inactive)
    for (const providerNum of providerNumbers) {
      const existing = dbNumberMap.get(providerNum.number);
      if (!existing) {
        const choice = chooseColor(null, activeColors, inactiveColors);
        await this.reclaimColor(choice, inactiveColors);
        activeColors.push(choice.color);

        this.logger.debug(`New number discovered: ${providerNum.number} — upserting with color ${choice.color}`);

        // Insert or update — the number may exist under a different (deleted)
        // provider. On conflict the number keeps its stored color unless we
        // deliberately reassign it (chooseColor already accounted for that).
        await this.db
          .insertInto('numbers')
          .values({
            number: providerNum.number,
            provider_id: providerId,
            label: null,
            color: choice.color,
            is_active: true,
            last_used_at: null,
          })
          .onConflict((oc) =>
            oc.column('number').doUpdateSet({
              provider_id: providerId,
              is_active: true,
              color: choice.color,
            })
          )
          .execute();
        added.push(providerNum.number);
      } else if (!existing.is_active) {
        this.logger.debug(`Re-activating previously removed number: ${providerNum.number}`);
        // Was previously removed, now re-added. Keep its persisted color if no
        // active number uses it; otherwise pick a new one (reclaiming from an
        // inactive number only if the palette is exhausted by active numbers).
        // Remove this number's own color from the inactive tracking first.
        if (existing.color) {
          const idx = inactiveColors.indexOf(existing.color);
          if (idx !== -1) inactiveColors.splice(idx, 1);
        }
        const choice = chooseColor(existing.color, activeColors, inactiveColors);
        await this.reclaimColor(choice, inactiveColors);
        activeColors.push(choice.color);
        await this.db
          .updateTable('numbers')
          .set({ is_active: true, color: choice.color })
          .where('number', '=', providerNum.number)
          .execute();
        added.push(providerNum.number);
      }
    }

    // Find removed numbers (in DB and active, but not in provider).
    // Orphan them: deactivate, detach, clear label. The color is PRESERVED so
    // the number keeps it if re-added; it is only reclaimed later if the palette
    // runs out of colors for active numbers. This hides them from the settings
    // UI (INNER JOIN on providers excludes NULL provider_id) while preserving
    // them for historical reference in messages and call_history.
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
        // The color is now held by an inactive number: move it in tracking so it
        // can be reclaimed if needed later in this same sync pass.
        if (dbNum.color) {
          const idx = activeColors.indexOf(dbNum.color);
          if (idx !== -1) activeColors.splice(idx, 1);
          inactiveColors.push(dbNum.color);
        }
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
   * Get the colors currently held by numbers, split by active state.
   * Colors persist for a number's lifetime, so inactive numbers keep a color;
   * their colors are reclaimed only when the palette is exhausted by active
   * numbers. `excludeNumber` omits the number being (re)assigned.
   */
  private async getColorUsage(
    excludeNumber?: string
  ): Promise<{ active: string[]; inactive: string[] }> {
    let query = this.db
      .selectFrom('numbers')
      .select(['color', 'is_active'])
      .where('color', 'is not', null);
    if (excludeNumber !== undefined) {
      query = query.where('number', '!=', excludeNumber);
    }
    const rows = await query.execute();
    const active: string[] = [];
    const inactive: string[] = [];
    for (const r of rows) {
      if (r.color == null) continue;
      if (r.is_active) active.push(r.color);
      else inactive.push(r.color);
    }
    return { active, inactive };
  }

  /**
   * If a color choice reclaims a color from an inactive number, null that
   * color on ONE inactive holder in the DB and drop it from the in-memory
   * inactive list. No-op when nothing is reclaimed.
   */
  private async reclaimColor(choice: ColorChoice, inactiveColors: string[]): Promise<void> {
    if (!choice.reclaimFrom) return;
    const reclaimFrom = choice.reclaimFrom;
    this.logger.debug(`Palette exhausted; reclaiming color ${reclaimFrom} from an inactive number`);
    await this.db
      .updateTable('numbers')
      .set({ color: null })
      .where(
        'number',
        '=',
        this.db
          .selectFrom('numbers')
          .select('number')
          .where('is_active', '=', false)
          .where('color', '=', reclaimFrom)
          .limit(1)
      )
      .execute();
    const idx = inactiveColors.indexOf(reclaimFrom);
    if (idx !== -1) inactiveColors.splice(idx, 1);
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
