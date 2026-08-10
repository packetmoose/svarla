import type { Kysely } from 'kysely';
import type { Database } from '../database.js';

/**
 * Counts of unread/unseen items for badge display.
 */
export interface ReadStateCounts {
  unreadMessages: number;
  unseenMissedCalls: number;
}

/**
 * WebSocket event emitted when read state changes.
 */
export interface ReadStateUpdatedEvent {
  type: 'read_state_updated';
  data: ReadStateCounts;
}

export type ReadStateBroadcastCallback = (event: ReadStateUpdatedEvent, excludeDeviceId?: string) => void;

/**
 * ReadStateService manages Global_Read_State tracking:
 * - Tracks which missed calls have been viewed (item_type='missed_calls', item_key='global')
 * - Tracks which message threads have been read (item_type='messages', item_key=phoneNumber)
 * - Provides badge counts: unseen missed calls + unread messages
 * - Broadcasts read_state_updated events to all devices for cross-device sync
 *
 * The read state works by comparing timestamps:
 * - missed_calls: all missed calls with timestamp > read_at are "unseen"
 * - messages: all received messages in a thread with timestamp > read_at are "unread"
 */
export class ReadStateService {
  private readonly db: Kysely<Database>;
  private readonly broadcast: ReadStateBroadcastCallback;

  constructor(db: Kysely<Database>, broadcast: ReadStateBroadcastCallback) {
    this.db = db;
    this.broadcast = broadcast;
  }

  /**
   * Mark all missed calls as viewed.
   * Sets the read_at timestamp for missed_calls to NOW().
   * Returns the updated counts and broadcasts to all other devices.
   */
  async markMissedCallsAsViewed(excludeDeviceId?: string): Promise<ReadStateCounts> {
    const now = new Date();

    // Upsert the read_state entry for missed_calls
    const existing = await this.db
      .selectFrom('read_state')
      .selectAll()
      .where('item_type', '=', 'missed_calls')
      .where('item_key', '=', 'global')
      .executeTakeFirst();

    if (existing) {
      await this.db
        .updateTable('read_state')
        .set({ read_at: now })
        .where('item_type', '=', 'missed_calls')
        .where('item_key', '=', 'global')
        .execute();
    } else {
      await this.db
        .insertInto('read_state')
        .values({
          item_type: 'missed_calls',
          item_key: 'global',
          read_at: now,
        })
        .execute();
    }

    const counts = await this.getCounts();

    // Broadcast to all other devices
    this.broadcast(
      { type: 'read_state_updated', data: counts },
      excludeDeviceId
    );

    return counts;
  }

  /**
   * Mark all messages in a specific thread as read.
   * Sets the read_at timestamp for that thread's phone number to NOW().
   * Returns the updated counts and broadcasts to all other devices.
   */
  async markThreadAsRead(phoneNumber: string, excludeDeviceId?: string): Promise<ReadStateCounts> {
    const now = new Date();

    // Upsert the read_state entry for this thread
    const existing = await this.db
      .selectFrom('read_state')
      .selectAll()
      .where('item_type', '=', 'messages')
      .where('item_key', '=', phoneNumber)
      .executeTakeFirst();

    if (existing) {
      await this.db
        .updateTable('read_state')
        .set({ read_at: now })
        .where('item_type', '=', 'messages')
        .where('item_key', '=', phoneNumber)
        .execute();
    } else {
      await this.db
        .insertInto('read_state')
        .values({
          item_type: 'messages',
          item_key: phoneNumber,
          read_at: now,
        })
        .execute();
    }

    const counts = await this.getCounts();

    // Broadcast to all other devices
    this.broadcast(
      { type: 'read_state_updated', data: counts },
      excludeDeviceId
    );

    return counts;
  }

  /**
   * Get the current badge counts:
   * - unseenMissedCalls: count of MISSED calls with timestamp > last read_at for missed_calls
   * - unreadMessages: count of RECEIVED messages with timestamp > last read_at for their respective thread
   */
  async getCounts(): Promise<ReadStateCounts> {
    const [unseenMissedCalls, unreadMessages] = await Promise.all([
      this.getUnseenMissedCallsCount(),
      this.getUnreadMessagesCount(),
    ]);

    return { unreadMessages, unseenMissedCalls };
  }

  /**
   * Count missed calls that have not been viewed.
   * A missed call is "unseen" if its timestamp is after the read_at for 'missed_calls/global',
   * or if no read_state entry exists (all missed calls are unseen).
   */
  private async getUnseenMissedCallsCount(): Promise<number> {
    // Get the last time missed calls were viewed
    const readState = await this.db
      .selectFrom('read_state')
      .select('read_at')
      .where('item_type', '=', 'missed_calls')
      .where('item_key', '=', 'global')
      .executeTakeFirst();

    let query = this.db
      .selectFrom('call_history')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('call_type', '=', 'MISSED');

    if (readState) {
      query = query.where('timestamp', '>', readState.read_at);
    }

    const result = await query.executeTakeFirstOrThrow();
    return parseInt(result.count, 10);
  }

  /**
   * Count received messages that have not been read.
   * A message is "unread" if its timestamp is after the read_at for its conversation thread,
   * or if no read_state entry exists for that thread (all messages in that thread are unread).
   */
  private async getUnreadMessagesCount(): Promise<number> {
    // Get all threads that have read state
    const readStates = await this.db
      .selectFrom('read_state')
      .select(['item_key', 'read_at'])
      .where('item_type', '=', 'messages')
      .execute();

    const readStateMap = new Map(
      readStates.map((rs) => [rs.item_key, rs.read_at])
    );

    // Get all conversations with received messages
    const conversations = await this.db
      .selectFrom('conversations')
      .select('phone_number')
      .execute();

    let totalUnread = 0;

    for (const conv of conversations) {
      const readAt = readStateMap.get(conv.phone_number);

      let query = this.db
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('conversation_number', '=', conv.phone_number)
        .where('direction', '=', 'RECEIVED');

      if (readAt) {
        query = query.where('timestamp', '>', readAt);
      }

      const result = await query.executeTakeFirstOrThrow();
      totalUnread += parseInt(result.count, 10);
    }

    return totalUnread;
  }
}
