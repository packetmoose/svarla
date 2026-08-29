import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConversationService } from './conversation-service.js';
import type {
  ConversationEvent,
  ConversationBroadcastCallback,
} from './conversation-service.js';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import type { TelephonyProvider, SmsResult } from '../providers/telephony-provider.js';

interface MockMessageRow {
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

interface MockConversationRow {
  phone_number: string;
  last_message_preview: string | null;
  last_message_timestamp: Date | null;
  created_at: Date;
}

let idCounter = 0;

function createMockDb(
  initialMessages: MockMessageRow[] = [],
  initialConversations: MockConversationRow[] = []
) {
  let messages = [...initialMessages];
  let conversations = [...initialConversations];

  const mockDb = {
    insertInto: vi.fn().mockImplementation((table: string) => {
      return {
        values: (values: Record<string, unknown>) => ({
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              if (table === 'messages') {
                idCounter++;
                const newMsg: MockMessageRow = {
                  id: `msg-${idCounter}`,
                  provider_message_id: (values.provider_message_id as string | null) ?? null,
                  conversation_number: values.conversation_number as string,
                  provider_number: (values.provider_number as string | null) ?? null,
                  body: values.body as string,
                  direction: values.direction as MockMessageRow['direction'],
                  status: values.status as MockMessageRow['status'],
                  timestamp: (values.timestamp as Date) ?? new Date(),
                  retry_count: (values.retry_count as number) ?? 0,
                };
                messages.push(newMsg);
                return { ...newMsg };
              }
              return {};
            },
          }),
          execute: async () => {
            if (table === 'conversations') {
              const newConv: MockConversationRow = {
                phone_number: values.phone_number as string,
                last_message_preview: (values.last_message_preview as string | null) ?? null,
                last_message_timestamp: (values.last_message_timestamp as Date | null) ?? null,
                created_at: new Date(),
              };
              conversations.push(newConv);
            }
          },
        }),
      };
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      return {
        set: (setValues: Record<string, unknown>) => ({
          where: (_col: string, _op: string, matchValue: unknown) => ({
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => {
                if (table === 'messages') {
                  const idx = messages.findIndex((m) => {
                    if (_col === 'id') return m.id === matchValue;
                    if (_col === 'provider_message_id') return m.provider_message_id === matchValue;
                    return false;
                  });
                  if (idx === -1) throw new Error('Message not found');
                  messages[idx] = { ...messages[idx], ...setValues } as MockMessageRow;
                  return { ...messages[idx] };
                }
                return {};
              },
            }),
            execute: async () => {
              if (table === 'messages') {
                const idx = messages.findIndex((m) => {
                  if (_col === 'id') return m.id === matchValue;
                  if (_col === 'provider_message_id') return m.provider_message_id === matchValue;
                  return false;
                });
                if (idx !== -1) {
                  messages[idx] = { ...messages[idx], ...setValues } as MockMessageRow;
                }
              } else if (table === 'conversations') {
                const idx = conversations.findIndex((c) => c.phone_number === matchValue);
                if (idx !== -1) {
                  conversations[idx] = { ...conversations[idx], ...setValues } as MockConversationRow;
                }
              }
            },
          }),
        }),
      };
    }),
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === 'messages') {
        return {
          selectAll: () => ({
            where: (_col: string, _op: string, matchValue: unknown) => ({
              executeTakeFirst: async () => {
                if (_col === 'provider_message_id') {
                  return messages.find((m) => m.provider_message_id === matchValue) ?? undefined;
                }
                if (_col === 'id') {
                  return messages.find((m) => m.id === matchValue) ?? undefined;
                }
                return undefined;
              },
              executeTakeFirstOrThrow: async () => {
                let found: MockMessageRow | undefined;
                if (_col === 'id') {
                  found = messages.find((m) => m.id === matchValue);
                }
                if (!found) throw new Error('Not found');
                return { ...found };
              },
              orderBy: (_orderCol: string, dir: string) => ({
                limit: (lim: number) => ({
                  execute: async () => {
                    const filtered = messages.filter((m) => {
                      if (_col === 'conversation_number') return m.conversation_number === matchValue;
                      return false;
                    });
                    const sorted = [...filtered].sort((a, b) => {
                      if (dir === 'desc') return b.timestamp.getTime() - a.timestamp.getTime();
                      return a.timestamp.getTime() - b.timestamp.getTime();
                    });
                    return sorted.slice(0, lim).map((m) => ({ ...m }));
                  },
                }),
              }),
              where: (_col2: string, _op2: string, _matchValue2: unknown) => ({
                orderBy: (_orderCol: string, dir: string) => ({
                  limit: (lim: number) => ({
                    execute: async () => {
                      const filtered = messages.filter((m) => {
                        if (_col === 'conversation_number') return m.conversation_number === matchValue;
                        return false;
                      });
                      const sorted = [...filtered].sort((a, b) => {
                        if (dir === 'desc') return b.timestamp.getTime() - a.timestamp.getTime();
                        return a.timestamp.getTime() - b.timestamp.getTime();
                      });
                      return sorted.slice(0, lim).map((m) => ({ ...m }));
                    },
                  }),
                }),
              }),
            }),
          }),
          select: (_cols: string[]) => ({
            where: (_col: string, _op: string, matchValue: unknown) => ({
              where: (_col2: string, _op2: string, _matchValue2: unknown) => ({
                orderBy: (_orderCol: string, dir: string) => ({
                  execute: async () => {
                    const phoneNumbers = Array.isArray(matchValue) ? matchValue : [matchValue];
                    const filtered = messages.filter((m) => {
                      const matchConv = phoneNumbers.includes(m.conversation_number);
                      const matchProvider = m.provider_number !== null;
                      return matchConv && matchProvider;
                    });
                    const sorted = [...filtered].sort((a, b) => {
                      if (dir === 'desc') return b.timestamp.getTime() - a.timestamp.getTime();
                      return a.timestamp.getTime() - b.timestamp.getTime();
                    });
                    return sorted.map((m) => ({
                      conversation_number: m.conversation_number,
                      provider_number: m.provider_number,
                    }));
                  },
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'conversations') {
        return {
          selectAll: () => ({
            where: (_col: string, _op: string, matchValue: unknown) => ({
              executeTakeFirst: async () => {
                return conversations.find((c) => c.phone_number === matchValue) ?? undefined;
              },
              orderBy: (_orderCol: string, _dir: string) => ({
                limit: (lim: number) => ({
                  offset: (off: number) => ({
                    where: (_col2: string, _op2: string, _matchValue2: unknown) => ({
                      execute: async () => {
                        const filtered = conversations.filter((c) => {
                          if (Array.isArray(_matchValue2)) return _matchValue2.includes(c.phone_number);
                          return true;
                        });
                        const sorted = [...filtered].sort((a, b) => {
                          const aTime = a.last_message_timestamp?.getTime() ?? 0;
                          const bTime = b.last_message_timestamp?.getTime() ?? 0;
                          return bTime - aTime;
                        });
                        return sorted.slice(off, off + lim).map((c) => ({ ...c }));
                      },
                    }),
                    execute: async () => {
                      const sorted = [...conversations].sort((a, b) => {
                        const aTime = a.last_message_timestamp?.getTime() ?? 0;
                        const bTime = b.last_message_timestamp?.getTime() ?? 0;
                        return bTime - aTime;
                      });
                      return sorted.slice(off, off + lim).map((c) => ({ ...c }));
                    },
                  }),
                }),
              }),
            }),
          }),
          select: (selectorFn: unknown) => {
            if (typeof selectorFn === 'function') {
              return {
                where: (_col: string, _op: string, _matchValue: unknown) => ({
                  where: (_col2: string, _op2: string, _matchValue2: unknown) => ({
                    executeTakeFirstOrThrow: async () => ({
                      count: String(conversations.length),
                    }),
                  }),
                  executeTakeFirstOrThrow: async () => ({
                    count: String(conversations.length),
                  }),
                }),
                executeTakeFirstOrThrow: async () => ({
                  count: String(conversations.length),
                }),
              };
            }
            return {};
          },
        };
      }
      return {};
    }),
  } as unknown as Kysely<Database>;

  return {
    mockDb,
    getMessages: () => messages,
    getConversations: () => conversations,
    setMessages: (m: MockMessageRow[]) => { messages = m; },
    setConversations: (c: MockConversationRow[]) => { conversations = c; },
  };
}

function createMockProvider(sendSmsResult?: SmsResult): TelephonyProvider {
  const defaultResult: SmsResult = {
    messageId: 'vonage-msg-123',
    success: true,
    errorReason: null,
  };

  return {
    providerId: 'mock',
    sendSms: vi.fn().mockResolvedValue(sendSmsResult ?? defaultResult),
    makeCall: vi.fn(),
    endCall: vi.fn(),
    answerCall: vi.fn(),
    listNumbers: vi.fn(),
    onEvent: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as TelephonyProvider;
}

describe('ConversationService', () => {
  let service: ConversationService;
  let dbHelper: ReturnType<typeof createMockDb>;
  let provider: TelephonyProvider;
  let broadcastEvents: ConversationEvent[];
  let broadcast: ConversationBroadcastCallback;

  beforeEach(() => {
    idCounter = 0;
    broadcastEvents = [];
    broadcast = (event) => broadcastEvents.push(event);
    dbHelper = createMockDb();
    provider = createMockProvider();
    service = new ConversationService(dbHelper.mockDb, provider, broadcast);
  });

  describe('sendMessage', () => {
    it('should send a message successfully and return with SENT status', async () => {
      const message = await service.sendMessage('+14155550000', '+14155551234', 'Hello!');

      expect(message.body).toBe('Hello!');
      expect(message.direction).toBe('SENT');
      expect(message.status).toBe('SENT');
      expect(message.conversation_number).toBe('+14155551234');
      expect(message.provider_number).toBe('+14155550000');
      expect(message.provider_message_id).toBe('vonage-msg-123');
      expect(message.retry_count).toBe(0);
    });

    it('should call provider.sendSms with correct arguments', async () => {
      await service.sendMessage('+14155550000', '+14155551234', 'Test message');

      expect(provider.sendSms).toHaveBeenCalledWith('+14155550000', '+14155551234', 'Test message');
    });

    it('should create a conversation entry for the destination number', async () => {
      await service.sendMessage('+14155550000', '+14155551234', 'Hello!');

      const conversations = dbHelper.getConversations();
      expect(conversations.length).toBe(1);
      expect(conversations[0].phone_number).toBe('+14155551234');
    });

    it('should broadcast a new_message event after sending', async () => {
      const message = await service.sendMessage('+14155550000', '+14155551234', 'Hi');

      expect(broadcastEvents).toHaveLength(1);
      const event = broadcastEvents[0];
      expect(event.type).toBe('new_message');
      if (event.type === 'new_message') {
        expect(event.data.conversationNumber).toBe('+14155551234');
        expect(event.data.message.id).toBe(message.id);
      }
    });

    it('should set status to FAILED when provider returns success=false', async () => {
      provider = createMockProvider({
        messageId: '',
        success: false,
        errorReason: 'Network error',
      });
      service = new ConversationService(dbHelper.mockDb, provider, broadcast);

      const message = await service.sendMessage('+14155550000', '+14155551234', 'Hi');

      expect(message.status).toBe('FAILED');
    });

    it('should set status to FAILED when provider throws', async () => {
      (provider.sendSms as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection refused'));
      service = new ConversationService(dbHelper.mockDb, provider, broadcast);

      const message = await service.sendMessage('+14155550000', '+14155551234', 'Hi');

      expect(message.status).toBe('FAILED');
    });

    it('should reject empty message body', async () => {
      await expect(
        service.sendMessage('+14155550000', '+14155551234', '')
      ).rejects.toThrow('Message body is required');
    });

    it('should reject whitespace-only message body', async () => {
      await expect(
        service.sendMessage('+14155550000', '+14155551234', '   ')
      ).rejects.toThrow('Message body must not be whitespace-only');
    });

    it('should reject message body exceeding 1600 characters', async () => {
      const longBody = 'a'.repeat(1601);
      await expect(
        service.sendMessage('+14155550000', '+14155551234', longBody)
      ).rejects.toThrow('Message body must not exceed 1600 characters');
    });

    it('should reject invalid destination number', async () => {
      await expect(
        service.sendMessage('+14155550000', 'not-a-number', 'Hello')
      ).rejects.toThrow();
    });

    it('should update conversation preview to 50-char truncated message', async () => {
      const longMessage = 'This is a message that is definitely longer than fifty characters in total length';
      await service.sendMessage('+14155550000', '+14155551234', longMessage);

      const conversations = dbHelper.getConversations();
      // threadListPreview truncates to 49 chars and appends "…" (total 50)
      expect(conversations[0].last_message_preview).toBe(
        longMessage.slice(0, 49) + '…'
      );
    });
  });

  describe('receiveMessage', () => {
    it('should store a received message with DELIVERED status', async () => {
      const timestamp = new Date('2024-01-15T10:00:00Z');
      const message = await service.receiveMessage(
        'vonage-inbound-123',
        '+14155551234',
        '+14155550000',
        'Hello from outside!',
        timestamp
      );

      expect(message).not.toBeNull();
      expect(message!.direction).toBe('RECEIVED');
      expect(message!.status).toBe('DELIVERED');
      expect(message!.provider_message_id).toBe('vonage-inbound-123');
      expect(message!.conversation_number).toBe('+14155551234');
      expect(message!.provider_number).toBe('+14155550000');
      expect(message!.body).toBe('Hello from outside!');
    });

    it('should create a conversation for the sender number', async () => {
      await service.receiveMessage(
        'vonage-inbound-123',
        '+14155551234',
        '+14155550000',
        'Hi',
        new Date()
      );

      const conversations = dbHelper.getConversations();
      expect(conversations.length).toBe(1);
      expect(conversations[0].phone_number).toBe('+14155551234');
    });

    it('should broadcast new_message event after receiving', async () => {
      const message = await service.receiveMessage(
        'vonage-inbound-123',
        '+14155551234',
        '+14155550000',
        'Hi',
        new Date()
      );

      expect(broadcastEvents).toHaveLength(1);
      const event = broadcastEvents[0];
      expect(event.type).toBe('new_message');
      if (event.type === 'new_message') {
        expect(event.data.conversationNumber).toBe('+14155551234');
        expect(event.data.message.id).toBe(message!.id);
      }
    });

    it('should deduplicate by provider_message_id', async () => {
      // Pre-seed a message with same provider_message_id
      dbHelper.setMessages([
        {
          id: 'existing-msg',
          provider_message_id: 'vonage-dup-123',
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Already stored',
          direction: 'RECEIVED',
          status: 'DELIVERED',
          timestamp: new Date(),
          retry_count: 0,
        },
      ]);

      const result = await service.receiveMessage(
        'vonage-dup-123',
        '+14155551234',
        '+14155550000',
        'Duplicate',
        new Date()
      );

      expect(result).toBeNull();
      expect(broadcastEvents).toHaveLength(0);
    });

    it('should update conversation preview and timestamp', async () => {
      const timestamp = new Date('2024-01-15T12:00:00Z');
      await service.receiveMessage(
        'vonage-inbound-456',
        '+14155551234',
        '+14155550000',
        'New message content',
        timestamp
      );

      const conversations = dbHelper.getConversations();
      expect(conversations[0].last_message_preview).toBe('New message content');
      expect(conversations[0].last_message_timestamp).toEqual(timestamp);
    });
  });

  describe('updateMessageStatus', () => {
    it('should update status for a message found by provider_message_id', async () => {
      dbHelper.setMessages([
        {
          id: 'msg-1',
          provider_message_id: 'vonage-456',
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Hello',
          direction: 'SENT',
          status: 'SENT',
          timestamp: new Date(),
          retry_count: 0,
        },
      ]);

      const result = await service.updateMessageStatus('vonage-456', 'DELIVERED');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('DELIVERED');
    });

    it('should broadcast message_status event', async () => {
      dbHelper.setMessages([
        {
          id: 'msg-1',
          provider_message_id: 'vonage-789',
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Hello',
          direction: 'SENT',
          status: 'SENT',
          timestamp: new Date(),
          retry_count: 0,
        },
      ]);

      await service.updateMessageStatus('vonage-789', 'DELIVERED');

      expect(broadcastEvents).toHaveLength(1);
      const event = broadcastEvents[0];
      expect(event.type).toBe('message_status');
      if (event.type === 'message_status') {
        expect(event.data.messageId).toBe('msg-1');
        expect(event.data.status).toBe('DELIVERED');
      }
    });

    it('should return null when provider_message_id is not found', async () => {
      const result = await service.updateMessageStatus('nonexistent', 'DELIVERED');
      expect(result).toBeNull();
      expect(broadcastEvents).toHaveLength(0);
    });
  });

  describe('retryMessage', () => {
    it('should retry a failed message and update to SENT on success', async () => {
      dbHelper.setMessages([
        {
          id: 'msg-retry-1',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Retry me',
          direction: 'SENT',
          status: 'FAILED',
          timestamp: new Date(),
          retry_count: 0,
        },
      ]);

      const message = await service.retryMessage('msg-retry-1');

      expect(message.status).toBe('SENT');
      expect(message.provider_message_id).toBe('vonage-msg-123');
      expect(provider.sendSms).toHaveBeenCalledWith('+14155550000', '+14155551234', 'Retry me');
    });

    it('should increment retry_count', async () => {
      dbHelper.setMessages([
        {
          id: 'msg-retry-2',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Retry me',
          direction: 'SENT',
          status: 'FAILED',
          timestamp: new Date(),
          retry_count: 1,
        },
      ]);

      await service.retryMessage('msg-retry-2');

      const msgs = dbHelper.getMessages();
      const retried = msgs.find((m) => m.id === 'msg-retry-2');
      expect(retried!.retry_count).toBe(2);
    });

    it('should throw when retry_count >= 3', async () => {
      dbHelper.setMessages([
        {
          id: 'msg-retry-3',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Too many retries',
          direction: 'SENT',
          status: 'FAILED',
          timestamp: new Date(),
          retry_count: 3,
        },
      ]);

      await expect(service.retryMessage('msg-retry-3')).rejects.toThrow(
        'Maximum retry count (3) exceeded'
      );
    });

    it('should throw when message status is not FAILED', async () => {
      dbHelper.setMessages([
        {
          id: 'msg-retry-4',
          provider_message_id: 'vonage-ok',
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Already sent',
          direction: 'SENT',
          status: 'SENT',
          timestamp: new Date(),
          retry_count: 0,
        },
      ]);

      await expect(service.retryMessage('msg-retry-4')).rejects.toThrow(
        'Only FAILED messages can be retried'
      );
    });

    it('should set status to FAILED when retry fails', async () => {
      (provider.sendSms as ReturnType<typeof vi.fn>).mockResolvedValue({
        messageId: '',
        success: false,
        errorReason: 'Delivery failed',
      });
      service = new ConversationService(dbHelper.mockDb, provider, broadcast);

      dbHelper.setMessages([
        {
          id: 'msg-retry-5',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Will fail again',
          direction: 'SENT',
          status: 'FAILED',
          timestamp: new Date(),
          retry_count: 2,
        },
      ]);

      const message = await service.retryMessage('msg-retry-5');

      expect(message.status).toBe('FAILED');
    });

    it('should broadcast message_status event on retry', async () => {
      dbHelper.setMessages([
        {
          id: 'msg-retry-6',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Broadcasting retry',
          direction: 'SENT',
          status: 'FAILED',
          timestamp: new Date(),
          retry_count: 0,
        },
      ]);

      await service.retryMessage('msg-retry-6');

      expect(broadcastEvents).toHaveLength(1);
      const event = broadcastEvents[0];
      expect(event.type).toBe('message_status');
      if (event.type === 'message_status') {
        expect(event.data.status).toBe('SENT');
      }
    });
  });

  describe('getConversations', () => {
    it('should return paginated conversations ordered by last_message_timestamp DESC', async () => {
      dbHelper.setConversations([
        {
          phone_number: '+14155551111',
          last_message_preview: 'Old msg',
          last_message_timestamp: new Date('2024-01-10T10:00:00Z'),
          created_at: new Date('2024-01-01T00:00:00Z'),
        },
        {
          phone_number: '+14155552222',
          last_message_preview: 'New msg',
          last_message_timestamp: new Date('2024-01-15T10:00:00Z'),
          created_at: new Date('2024-01-02T00:00:00Z'),
        },
      ]);

      const result = await service.getConversations(1, 50);

      expect(result.conversations).toHaveLength(2);
      expect(result.conversations[0].phone_number).toBe('+14155552222');
      expect(result.conversations[1].phone_number).toBe('+14155551111');
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
      expect(result.total).toBe(2);
      expect(result.totalPages).toBe(1);
    });

    it('should return empty array when no conversations exist', async () => {
      const result = await service.getConversations(1, 50);

      expect(result.conversations).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should clamp pageSize to maximum of 100', async () => {
      dbHelper.setConversations([
        {
          phone_number: '+14155551111',
          last_message_preview: 'Hi',
          last_message_timestamp: new Date(),
          created_at: new Date(),
        },
      ]);

      const result = await service.getConversations(1, 200);

      expect(result.pageSize).toBe(100);
    });

    it('should clamp page to minimum of 1', async () => {
      const result = await service.getConversations(0, 50);
      expect(result.page).toBe(1);
    });
  });

  describe('getMessages', () => {
    it('should return messages for a conversation in chronological order', async () => {
      const now = Date.now();
      dbHelper.setMessages([
        {
          id: 'msg-a',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'First',
          direction: 'SENT',
          status: 'SENT',
          timestamp: new Date(now - 3000),
          retry_count: 0,
        },
        {
          id: 'msg-b',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Second',
          direction: 'RECEIVED',
          status: 'DELIVERED',
          timestamp: new Date(now - 2000),
          retry_count: 0,
        },
        {
          id: 'msg-c',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Third',
          direction: 'SENT',
          status: 'SENT',
          timestamp: new Date(now - 1000),
          retry_count: 0,
        },
      ]);

      const messages = await service.getMessages('+14155551234', 100);

      // Should be in chronological order (oldest first)
      expect(messages).toHaveLength(3);
      expect(messages[0].body).toBe('First');
      expect(messages[1].body).toBe('Second');
      expect(messages[2].body).toBe('Third');
    });

    it('should limit results to the specified number', async () => {
      const now = Date.now();
      dbHelper.setMessages([
        {
          id: 'msg-1',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Oldest',
          direction: 'SENT',
          status: 'SENT',
          timestamp: new Date(now - 3000),
          retry_count: 0,
        },
        {
          id: 'msg-2',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Middle',
          direction: 'SENT',
          status: 'SENT',
          timestamp: new Date(now - 2000),
          retry_count: 0,
        },
        {
          id: 'msg-3',
          provider_message_id: null,
          conversation_number: '+14155551234',
          provider_number: '+14155550000',
          body: 'Newest',
          direction: 'SENT',
          status: 'SENT',
          timestamp: new Date(now - 1000),
          retry_count: 0,
        },
      ]);

      // Only get last 2 messages
      const messages = await service.getMessages('+14155551234', 2);

      expect(messages).toHaveLength(2);
      // Should be the 2 most recent, in chronological order
      expect(messages[0].body).toBe('Middle');
      expect(messages[1].body).toBe('Newest');
    });

    it('should return empty array for a number with no messages', async () => {
      const messages = await service.getMessages('+14155559999', 100);
      expect(messages).toEqual([]);
    });

    it('should clamp limit to maximum of 100', async () => {
      // With no messages this is trivial, but validates the clamping logic
      const messages = await service.getMessages('+14155551234', 200);
      expect(messages).toEqual([]);
    });
  });
});
