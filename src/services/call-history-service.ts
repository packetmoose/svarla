import type { Kysely } from 'kysely';
import type { Database } from '../database.js';

export interface CallHistoryEntry {
  id: string;
  phone_number: string;
  provider_number: string | null;
  call_type: 'INCOMING' | 'OUTGOING' | 'MISSED' | 'UNANSWERED' | 'DECLINED' | 'BLOCKED';
  timestamp: Date;
  duration_seconds: number | null;
  provider_call_id: string | null;
  answered_by_device: string | null;
  real_caller_number: string | null;
}

export interface RecordCallInput {
  id?: string;
  phone_number: string;
  provider_number?: string | null;
  call_type: 'INCOMING' | 'OUTGOING' | 'MISSED' | 'UNANSWERED' | 'DECLINED' | 'BLOCKED';
  duration_seconds?: number | null;
  provider_call_id?: string | null;
  answered_by_device?: string | null;
}

export interface PaginatedHistory {
  entries: CallHistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type CallHistoryEvent = {
  type: 'call_history_update';
  entry: CallHistoryEntry;
};

export type CallHistoryBroadcastCallback = (event: CallHistoryEvent) => void;

const MAX_HISTORY_ENTRIES = 1000;

/**
 * CallHistoryService manages call history in the database:
 * - Records new call entries (INCOMING, OUTGOING, MISSED, UNANSWERED)
 * - Enforces the 1000 entry cap by removing oldest entries on overflow
 * - Provides paginated and recent history queries
 * - Broadcasts updates via a callback (for WebSocket delivery)
 */
export class CallHistoryService {
  private readonly db: Kysely<Database>;
  private readonly broadcast: CallHistoryBroadcastCallback;

  constructor(db: Kysely<Database>, broadcast: CallHistoryBroadcastCallback) {
    this.db = db;
    this.broadcast = broadcast;
  }

  /**
   * Record a new call in the history.
   * After inserting, enforces the 1000 entry cap by deleting oldest entries if needed.
   * Broadcasts the new entry to all connected devices.
   */
  async recordCall(input: RecordCallInput): Promise<CallHistoryEntry> {
    const inserted = await this.db
      .insertInto('call_history')
      .values({
        ...(input.id ? { id: input.id } : {}),
        phone_number: input.phone_number,
        provider_number: input.provider_number ?? null,
        call_type: input.call_type,
        duration_seconds: input.duration_seconds ?? null,
        provider_call_id: input.provider_call_id ?? null,
        answered_by_device: input.answered_by_device ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Enforce the 1000 entry cap
    await this.enforceEntryCap();

    const entry: CallHistoryEntry = {
      id: inserted.id,
      phone_number: inserted.phone_number,
      provider_number: inserted.provider_number,
      call_type: inserted.call_type,
      timestamp: inserted.timestamp,
      duration_seconds: inserted.duration_seconds,
      provider_call_id: inserted.provider_call_id,
      answered_by_device: inserted.answered_by_device,
      real_caller_number: inserted.real_caller_number ?? null,
    };

    // Broadcast update to all connected devices
    this.broadcast({
      type: 'call_history_update',
      entry,
    });

    return entry;
  }

  /**
   * Update the call_type of an existing call history entry identified by provider_call_id.
   * Used to transition an INCOMING call to MISSED when it ends without being answered.
   * Only updates if the current call_type is INCOMING (guards against race conditions
   * where the call was answered and updated to INCOMING with duration before this runs).
   *
   * Returns the updated entry, or null if no matching entry was found or it was already updated.
   */
  async updateCallTypeByProviderCallId(
    providerCallId: string,
    callType: 'INCOMING' | 'OUTGOING' | 'MISSED' | 'UNANSWERED' | 'DECLINED' | 'BLOCKED',
    durationSeconds?: number | null
  ): Promise<CallHistoryEntry | null> {
    const updateBuilder = this.db
      .updateTable('call_history')
      .where('provider_call_id', '=', providerCallId)
      .where('call_type', '=', 'INCOMING')
      .where('answered_by_device', 'is', null);

    const updated = await (durationSeconds != null
      ? updateBuilder.set({ call_type: callType, duration_seconds: durationSeconds })
      : updateBuilder.set({ call_type: callType })
    )
      .returningAll()
      .executeTakeFirst();

    if (!updated) return null;

    const entry: CallHistoryEntry = {
      id: updated.id,
      phone_number: updated.phone_number,
      provider_number: updated.provider_number,
      call_type: updated.call_type,
      timestamp: updated.timestamp,
      duration_seconds: updated.duration_seconds,
      provider_call_id: updated.provider_call_id,
      answered_by_device: updated.answered_by_device,
      real_caller_number: updated.real_caller_number ?? null,
    };

    // Broadcast update to all connected devices
    this.broadcast({
      type: 'call_history_update',
      entry,
    });

    return entry;
  }

  /**
   * Mark a call as answered by setting the answered_by_device field.
   * This prevents the call from being incorrectly marked as MISSED when it completes,
   * since the missed-call logic only matches entries where answered_by_device IS NULL.
   */
  async markAnswered(providerCallId: string, deviceId: string): Promise<void> {
    await this.db
      .updateTable('call_history')
      .where('provider_call_id', '=', providerCallId)
      .set({ answered_by_device: deviceId })
      .execute();
  }

  /**
   * Update the duration of a call history entry identified by provider_call_id.
   * Used to set the final duration on outbound calls when they complete.
   * Unlike updateCallTypeByProviderCallId, this matches any call_type (including OUTGOING).
   *
   * Returns the updated entry, or null if no matching entry was found.
   */
  async updateDurationByProviderCallId(
    providerCallId: string,
    durationSeconds: number
  ): Promise<CallHistoryEntry | null> {
    const updated = await this.db
      .updateTable('call_history')
      .where('provider_call_id', '=', providerCallId)
      .set({ duration_seconds: durationSeconds })
      .returningAll()
      .executeTakeFirst();

    if (!updated) return null;

    const entry: CallHistoryEntry = {
      id: updated.id,
      phone_number: updated.phone_number,
      provider_number: updated.provider_number,
      call_type: updated.call_type,
      timestamp: updated.timestamp,
      duration_seconds: updated.duration_seconds,
      provider_call_id: updated.provider_call_id,
      answered_by_device: updated.answered_by_device,
      real_caller_number: updated.real_caller_number ?? null,
    };

    // Broadcast update to all connected devices
    this.broadcast({
      type: 'call_history_update',
      entry,
    });

    return entry;
  }

  /**
   * Update the call_type of an outbound call to UNANSWERED when the remote party
   * does not pick up. Matches entries with call_type = 'OUTGOING'.
   *
   * Returns the updated entry, or null if no matching entry was found.
   */
  async markOutboundUnanswered(providerCallId: string): Promise<CallHistoryEntry | null> {
    const updated = await this.db
      .updateTable('call_history')
      .where('provider_call_id', '=', providerCallId)
      .where('call_type', '=', 'OUTGOING')
      .set({ call_type: 'UNANSWERED' as const })
      .returningAll()
      .executeTakeFirst();

    if (!updated) return null;

    const entry: CallHistoryEntry = {
      id: updated.id,
      phone_number: updated.phone_number,
      provider_number: updated.provider_number,
      call_type: updated.call_type,
      timestamp: updated.timestamp,
      duration_seconds: updated.duration_seconds,
      provider_call_id: updated.provider_call_id,
      answered_by_device: updated.answered_by_device,
      real_caller_number: updated.real_caller_number ?? null,
    };

    // Broadcast update to all connected devices
    this.broadcast({
      type: 'call_history_update',
      entry,
    });

    return entry;
  }

  /**
   * Store the real caller number revealed in Vonage's "completed" event.
   * When a caller uses CLIR (anonymous), Vonage still includes the real number
   * in the CDR-style completed event. This stores it separately for internal use
   * without exposing it as the caller identity.
   */
  async setRevealedNumber(providerCallId: string, realNumber: string): Promise<void> {
    await this.db
      .updateTable('call_history')
      .where('provider_call_id', '=', providerCallId)
      .set({ real_caller_number: realNumber })
      .execute();
  }

  /**
   * Get paginated call history ordered by timestamp DESC (most recent first).
   */
  async getHistory(page: number, pageSize: number, providerNumber?: string): Promise<PaginatedHistory> {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.max(1, Math.min(100, Math.floor(pageSize)));
    const offset = (safePage - 1) * safePageSize;

    let entriesQuery = this.db
      .selectFrom('call_history')
      .selectAll()
      .orderBy('timestamp', 'desc')
      .limit(safePageSize)
      .offset(offset);

    let countQuery = this.db
      .selectFrom('call_history')
      .select((eb) => eb.fn.countAll<string>().as('count'));

    if (providerNumber) {
      entriesQuery = entriesQuery.where('provider_number', '=', providerNumber);
      countQuery = countQuery.where('provider_number', '=', providerNumber);
    }

    const [entries, countResult] = await Promise.all([
      entriesQuery.execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);

    const total = parseInt(countResult.count, 10);
    const totalPages = Math.ceil(total / safePageSize);

    return {
      entries: entries.map((e) => ({
        id: e.id,
        phone_number: e.phone_number,
        provider_number: e.provider_number,
        call_type: e.call_type,
        timestamp: e.timestamp,
        duration_seconds: e.duration_seconds,
        provider_call_id: e.provider_call_id,
        answered_by_device: e.answered_by_device,
        real_caller_number: e.real_caller_number ?? null,
      })),
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages,
    };
  }

  /**
   * Get the N most recent call history entries.
   */
  async getRecentHistory(limit: number): Promise<CallHistoryEntry[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));

    const entries = await this.db
      .selectFrom('call_history')
      .selectAll()
      .orderBy('timestamp', 'desc')
      .limit(safeLimit)
      .execute();

    return entries.map((e) => ({
      id: e.id,
      phone_number: e.phone_number,
      provider_number: e.provider_number,
      call_type: e.call_type,
      timestamp: e.timestamp,
      duration_seconds: e.duration_seconds,
      provider_call_id: e.provider_call_id,
      answered_by_device: e.answered_by_device,
      real_caller_number: e.real_caller_number ?? null,
    }));
  }

  /**
   * Enforce the 1000 entry cap.
   * If the total count exceeds 1000, delete the oldest entries to bring it back to 1000.
   */
  private async enforceEntryCap(): Promise<void> {
    const countResult = await this.db
      .selectFrom('call_history')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();

    const total = parseInt(countResult.count, 10);

    if (total > MAX_HISTORY_ENTRIES) {
      const excess = total - MAX_HISTORY_ENTRIES;

      // Get the IDs of the oldest entries to delete
      const oldestEntries = await this.db
        .selectFrom('call_history')
        .select('id')
        .orderBy('timestamp', 'asc')
        .limit(excess)
        .execute();

      if (oldestEntries.length > 0) {
        const idsToDelete = oldestEntries.map((e) => e.id);
        await this.db
          .deleteFrom('call_history')
          .where('id', 'in', idsToDelete)
          .execute();
      }
    }
  }
}
