import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import type { TelephonyProvider, SmsResult } from '../providers/telephony-provider.js';
import { validateMessage } from '../validators/message-validator.js';
import { validatePhoneNumber, normalizeToE164 } from '../validators/phone-number-validator.js';
import { threadListPreview } from '../formatters/message-preview.js';

export interface Message {
  id: string;
  provider_message_id: string | null;
  conversation_number: string;
  provider_number: string | null;
  body: string;
  direction: 'SENT' | 'RECEIVED';
  status: 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'QUEUED';
  timestamp: Date;
  retry_count: number;
}

export interface Conversation {
  phone_number: string;
  provider_number: string | null;
  last_message_preview: string | null;
  last_message_timestamp: Date | null;
  created_at: Date;
}

export interface PaginatedConversations {
  conversations: Conversation[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type ConversationEvent =
  | { type: 'new_message'; data: { conversationNumber: string; message: Message } }
  | { type: 'message_status'; data: { messageId: string; status: string } };

export type ConversationBroadcastCallback = (event: ConversationEvent) => void;

/**
 * Resolves the telephony provider that owns a given "from" number.
 * Returning null/undefined (or throwing) means no specific provider could be
 * resolved; callers fall back to the default injected provider.
 */
export type ProviderResolver = (
  from: string
) => Promise<TelephonyProvider | null> | TelephonyProvider | null;

const MAX_RETRIES = 3;

/**
 * ConversationService manages SMS conversation threads:
 * - Stores messages in conversation threads keyed by E.164 normalized number
 * - Handles deduplication by provider_message_id
 * - Manages message status transitions (PENDING → SENT/FAILED)
 * - Implements retry logic (max 3 retries)
 * - Broadcasts new messages and status updates via callback (for WebSocket delivery)
 */
export class ConversationService {
  private readonly db: Kysely<Database>;
  private readonly provider: TelephonyProvider;
  private readonly broadcast: ConversationBroadcastCallback;
  private readonly resolveProvider?: ProviderResolver;

  constructor(
    db: Kysely<Database>,
    provider: TelephonyProvider,
    broadcast: ConversationBroadcastCallback,
    resolveProvider?: ProviderResolver
  ) {
    this.db = db;
    this.provider = provider;
    this.broadcast = broadcast;
    this.resolveProvider = resolveProvider;
  }

  /**
   * Resolve the provider that should dispatch an outbound message from the
   * given number. Uses the per-number resolver when available so the message
   * is routed to the provider that actually owns the "from" number (e.g. the
   * modem-gateway), instead of a single statically-chosen provider.
   * Falls back to the injected default provider when no resolver is configured
   * or the resolver cannot determine a provider.
   */
  private async providerFor(from: string): Promise<TelephonyProvider> {
    if (this.resolveProvider) {
      const resolved = await this.resolveProvider(from);
      if (resolved) {
        return resolved;
      }
    }
    return this.provider;
  }

  /**
   * Send an outbound SMS message.
   * Validates body, upserts conversation, inserts message with PENDING status,
   * calls provider.sendSms(), updates status to SENT or FAILED,
   * updates conversation metadata, and broadcasts.
   */
  async sendMessage(from: string, to: string, body: string): Promise<Message> {
    // Validate body
    const bodyValidation = validateMessage(body);
    if (!bodyValidation.valid) {
      throw new Error(bodyValidation.error ?? 'Invalid message body');
    }

    // Validate destination number
    const numberValidation = validatePhoneNumber(to);
    if (!numberValidation.valid) {
      throw new Error(numberValidation.error ?? 'Invalid destination number');
    }

    // Normalize local numbers to E.164 using the from number's country code
    const normalizedTo = normalizeToE164(to, from);

    // Upsert conversation (keyed by normalized number)
    await this.upsertConversation(normalizedTo);

    // Insert message with PENDING status
    const inserted = await this.db
      .insertInto('messages')
      .values({
        conversation_number: normalizedTo,
        provider_number: from,
        body,
        direction: 'SENT',
        status: 'PENDING',
        retry_count: 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    let message: Message = this.mapRow(inserted);

    // Send via the provider that owns the `from` number (use normalizedTo for
    // E.164 providers, original for local-capable providers)
    let result: SmsResult;
    try {
      const provider = await this.providerFor(from);
      result = await provider.sendSms(from, normalizedTo, body);
    } catch {
      // Provider threw — mark as FAILED
      message = await this.updateStatus(message.id, 'FAILED');
      await this.updateConversationMetadata(normalizedTo, body);
      this.broadcast({ type: 'new_message', data: { conversationNumber: normalizedTo, message } });
      return message;
    }

    if (result.success) {
      // The message was physically sent. Update status to SENT and record the
      // provider_message_id. This UPDATE is wrapped defensively: the message has
      // already been sent, so a post-send DB error (e.g. a UNIQUE collision on a
      // non-unique provider_message_id) must NOT leave the row stuck at PENDING
      // or surface as a 500 to the caller.
      try {
        const updated = await this.db
          .updateTable('messages')
          .set({ status: 'SENT', provider_message_id: result.messageId })
          .where('id', '=', message.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        message = this.mapRow(updated);
      } catch {
        // Retry without provider_message_id so the status still advances to SENT.
        const updated = await this.db
          .updateTable('messages')
          .set({ status: 'SENT' })
          .where('id', '=', message.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        message = this.mapRow(updated);
      }
    } else {
      message = await this.updateStatus(message.id, 'FAILED');
    }

    // Update conversation metadata
    await this.updateConversationMetadata(normalizedTo, body);

    // Broadcast new message event
    this.broadcast({ type: 'new_message', data: { conversationNumber: normalizedTo, message } });

    return message;
  }

  /**
   * Receive an inbound SMS message.
   * Deduplicates by provider_message_id, upserts conversation, inserts message,
   * updates conversation metadata, and broadcasts.
   */
  async receiveMessage(
    messageId: string,
    from: string,
    to: string,
    body: string,
    timestamp: Date
  ): Promise<Message | null> {
    // Deduplication: check if provider_message_id already exists
    if (messageId) {
      const existing = await this.db
        .selectFrom('messages')
        .selectAll()
        .where('provider_message_id', '=', messageId)
        .executeTakeFirst();

      if (existing) {
        return null; // Duplicate — skip
      }
    }

    // Upsert conversation (keyed by E.164 normalized `from`)
    await this.upsertConversation(from);

    // Insert message with RECEIVED/DELIVERED
    const inserted = await this.db
      .insertInto('messages')
      .values({
        provider_message_id: messageId || null,
        conversation_number: from,
        provider_number: to,
        body,
        direction: 'RECEIVED',
        status: 'DELIVERED',
        timestamp,
        retry_count: 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const message = this.mapRow(inserted);

    // Update conversation metadata
    await this.updateConversationMetadata(from, body, timestamp);

    // Broadcast new message event
    this.broadcast({ type: 'new_message', data: { conversationNumber: from, message } });

    return message;
  }

  /**
   * Update a message status by provider_message_id.
   * Used for delivery receipts from the provider.
   */
  async updateMessageStatus(providerMessageId: string, status: 'DELIVERED' | 'FAILED'): Promise<Message | null> {
    const existing = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('provider_message_id', '=', providerMessageId)
      .executeTakeFirst();

    if (!existing) {
      return null;
    }

    const updated = await this.db
      .updateTable('messages')
      .set({ status })
      .where('provider_message_id', '=', providerMessageId)
      .returningAll()
      .executeTakeFirstOrThrow();

    const message = this.mapRow(updated);

    // Broadcast status update
    this.broadcast({ type: 'message_status', data: { messageId: message.id, status } });

    return message;
  }

  /**
   * Retry sending a failed message.
   * Checks retry_count < MAX_RETRIES, increments, re-sends, updates status.
   */
  async retryMessage(messageId: string): Promise<Message> {
    const existing = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();

    if (existing.retry_count >= MAX_RETRIES) {
      throw new Error(`Maximum retry count (${MAX_RETRIES}) exceeded`);
    }

    if (existing.status !== 'FAILED') {
      throw new Error('Only FAILED messages can be retried');
    }

    // Increment retry count and set status back to PENDING
    await this.db
      .updateTable('messages')
      .set({ retry_count: existing.retry_count + 1, status: 'PENDING' })
      .where('id', '=', messageId)
      .execute();

    // Re-send via the provider that owns the `from` number
    let result: SmsResult;
    try {
      const provider = await this.providerFor(existing.provider_number ?? '');
      result = await provider.sendSms(
        existing.provider_number ?? '',
        existing.conversation_number,
        existing.body
      );
    } catch {
      const updated = await this.db
        .updateTable('messages')
        .set({ status: 'FAILED' })
        .where('id', '=', messageId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const message = this.mapRow(updated);
      this.broadcast({ type: 'message_status', data: { messageId: message.id, status: 'FAILED' } });
      return message;
    }

    if (result.success) {
      const updated = await this.db
        .updateTable('messages')
        .set({ status: 'SENT', provider_message_id: result.messageId })
        .where('id', '=', messageId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const message = this.mapRow(updated);
      this.broadcast({ type: 'message_status', data: { messageId: message.id, status: 'SENT' } });
      return message;
    } else {
      const updated = await this.db
        .updateTable('messages')
        .set({ status: 'FAILED' })
        .where('id', '=', messageId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const message = this.mapRow(updated);
      this.broadcast({ type: 'message_status', data: { messageId: message.id, status: 'FAILED' } });
      return message;
    }
  }

  /**
   * Get conversation threads ordered by last_message_timestamp DESC, paginated.
   */
  async getConversations(page: number, pageSize: number, providerNumber?: string): Promise<PaginatedConversations> {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.max(1, Math.min(100, Math.floor(pageSize)));
    const offset = (safePage - 1) * safePageSize;

    // If filtering by provider number, find conversations that have messages with that provider number
    let filteredPhoneNumbers: string[] | null = null;
    if (providerNumber) {
      const rows = await this.db
        .selectFrom('messages')
        .select('conversation_number')
        .where('provider_number', '=', providerNumber)
        .groupBy('conversation_number')
        .execute();
      filteredPhoneNumbers = rows.map((r) => r.conversation_number);
      if (filteredPhoneNumbers.length === 0) {
        return { conversations: [], page: safePage, pageSize: safePageSize, total: 0, totalPages: 0 };
      }
    }

    let conversationsQuery = this.db
      .selectFrom('conversations')
      .selectAll()
      .where('removed', '=', false)
      .orderBy('last_message_timestamp', 'desc')
      .limit(safePageSize)
      .offset(offset);

    let countQuery = this.db
      .selectFrom('conversations')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('removed', '=', false);

    if (filteredPhoneNumbers) {
      conversationsQuery = conversationsQuery.where('phone_number', 'in', filteredPhoneNumbers);
      countQuery = countQuery.where('phone_number', 'in', filteredPhoneNumbers);
    }

    const [conversations, countResult] = await Promise.all([
      conversationsQuery.execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);

    const total = parseInt(countResult.count, 10);
    const totalPages = Math.ceil(total / safePageSize);

    // Look up most recent provider_number for each conversation
    const phoneNumbers = conversations.map((c) => c.phone_number);
    const providerNumbers = await this.getConversationProviderNumbers(phoneNumbers);

    return {
      conversations: conversations.map((c) => ({
        phone_number: c.phone_number,
        provider_number: providerNumbers.get(c.phone_number) ?? null,
        last_message_preview: c.last_message_preview,
        last_message_timestamp: c.last_message_timestamp,
        created_at: c.created_at,
      })),
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages,
    };
  }

  /**
   * Get the most recently used provider_number for each conversation.
   * Returns a Map of phoneNumber → provider_number.
   */
  private async getConversationProviderNumbers(phoneNumbers: string[]): Promise<Map<string, string>> {
    if (phoneNumbers.length === 0) return new Map();

    // For each conversation, get the provider_number from the most recent message that has one
    const rows = await this.db
      .selectFrom('messages')
      .select(['conversation_number', 'provider_number'])
      .where('conversation_number', 'in', phoneNumbers)
      .where('provider_number', 'is not', null)
      .orderBy('timestamp', 'desc')
      .execute();

    const map = new Map<string, string>();
    for (const row of rows) {
      // Only take the first (most recent) provider_number per conversation
      if (!map.has(row.conversation_number) && row.provider_number) {
        map.set(row.conversation_number, row.provider_number);
      }
    }
    return map;
  }

  /**
   * Get per-thread read_at timestamps for a list of phone numbers.
   * Returns a Map of phoneNumber → read_at Date.
   */
  async getThreadReadStates(phoneNumbers: string[]): Promise<Map<string, Date>> {
    if (phoneNumbers.length === 0) return new Map();

    const readStates = await this.db
      .selectFrom('read_state')
      .select(['item_key', 'read_at'])
      .where('item_type', '=', 'messages')
      .where('item_key', 'in', phoneNumbers)
      .execute();

    return new Map(readStates.map((rs) => [rs.item_key, rs.read_at]));
  }

  /**
   * Get the timestamp of the last RECEIVED message per conversation thread.
   * Returns a Map of phoneNumber → timestamp.
   */
  async getLastReceivedTimestamps(phoneNumbers: string[]): Promise<Map<string, Date>> {
    if (phoneNumbers.length === 0) return new Map();

    const results = new Map<string, Date>();

    for (const phoneNumber of phoneNumbers) {
      const row = await this.db
        .selectFrom('messages')
        .select('timestamp')
        .where('conversation_number', '=', phoneNumber)
        .where('direction', '=', 'RECEIVED')
        .orderBy('timestamp', 'desc')
        .limit(1)
        .executeTakeFirst();

      if (row) {
        results.set(phoneNumber, row.timestamp);
      }
    }

    return results;
  }

  /**
   * Get the last N messages in a thread ordered chronologically (oldest first).
   */
  async getMessages(phoneNumber: string, limit: number = 100): Promise<Message[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));

    const messages = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('conversation_number', '=', phoneNumber)
      .where('removed', '=', false)
      .orderBy('timestamp', 'desc')
      .limit(safeLimit)
      .execute();

    // Reverse so they are in chronological order (oldest first)
    return messages.reverse().map((m) => this.mapRow(m));
  }

  /**
   * Mark a conversation as removed. It won't be returned in getConversations.
   * Does not permanently delete the data.
   */
  async removeConversation(phoneNumber: string): Promise<void> {
    await this.db
      .updateTable('conversations')
      .set({ removed: true })
      .where('phone_number', '=', phoneNumber)
      .execute();
  }

  /**
   * Mark a single message as removed. It won't be returned in getMessages.
   * Does not permanently delete the data.
   */
  async removeMessage(messageId: string): Promise<void> {
    await this.db
      .updateTable('messages')
      .set({ removed: true })
      .where('id', '=', messageId)
      .execute();
  }

  /**
   * Restore a previously removed message (undo removal).
   */
  async restoreMessage(messageId: string): Promise<void> {
    await this.db
      .updateTable('messages')
      .set({ removed: false })
      .where('id', '=', messageId)
      .execute();
  }

  /**
   * Upsert a conversation entry. If it already exists, un-remove it so it reappears.
   */
  private async upsertConversation(phoneNumber: string): Promise<void> {
    const existing = await this.db
      .selectFrom('conversations')
      .selectAll()
      .where('phone_number', '=', phoneNumber)
      .executeTakeFirst();

    if (!existing) {
      await this.db
        .insertInto('conversations')
        .values({
          phone_number: phoneNumber,
          last_message_preview: null,
          last_message_timestamp: null,
        })
        .execute();
    } else if (existing.removed) {
      // Un-remove the conversation when a new message arrives
      await this.db
        .updateTable('conversations')
        .set({ removed: false })
        .where('phone_number', '=', phoneNumber)
        .execute();
    }
  }

  /**
   * Update conversation's last_message_preview and last_message_timestamp.
   */
  private async updateConversationMetadata(
    phoneNumber: string,
    body: string,
    timestamp?: Date
  ): Promise<void> {
    const preview = threadListPreview(body);
    await this.db
      .updateTable('conversations')
      .set({
        last_message_preview: preview,
        last_message_timestamp: timestamp ?? new Date(),
      })
      .where('phone_number', '=', phoneNumber)
      .execute();
  }

  /**
   * Update message status by message ID.
   */
  private async updateStatus(messageId: string, status: Message['status']): Promise<Message> {
    const updated = await this.db
      .updateTable('messages')
      .set({ status })
      .where('id', '=', messageId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.mapRow(updated);
  }

  /**
   * Map a raw database row to the Message interface.
   */
  private mapRow(row: {
    id: string;
    provider_message_id: string | null;
    conversation_number: string;
    provider_number: string | null;
    body: string;
    direction: 'SENT' | 'RECEIVED';
    status: 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'QUEUED';
    timestamp: Date;
    retry_count: number;
  }): Message {
    return {
      id: row.id,
      provider_message_id: row.provider_message_id,
      conversation_number: row.conversation_number,
      provider_number: row.provider_number,
      body: row.body,
      direction: row.direction,
      status: row.status,
      timestamp: row.timestamp,
      retry_count: row.retry_count,
    };
  }
}
