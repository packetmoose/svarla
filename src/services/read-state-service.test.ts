import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReadStateService } from './read-state-service.js';
import type { ReadStateUpdatedEvent, ReadStateBroadcastCallback } from './read-state-service.js';

/**
 * Tests for ReadStateService.
 *
 * Uses an in-memory mock of the Kysely database to test the service logic
 * without requiring a real PostgreSQL connection.
 */

// Mock database builder that chains method calls
function createMockDb() {
  const readStateRows: Array<{
    id: string;
    item_type: string;
    item_key: string;
    read_at: Date;
  }> = [];

  const callHistoryRows: Array<{
    id: string;
    call_type: string;
    timestamp: Date;
    phone_number: string;
  }> = [];

  const conversationRows: Array<{ phone_number: string; provider_number: string }> = [];

  const messageRows: Array<{
    id: string;
    conversation_number: string;
    direction: string;
    timestamp: Date;
  }> = [];

  // Helper to create a chainable query builder mock
  function createQueryChain(resolveWith: () => unknown) {
    const chain: Record<string, unknown> = {};
    const methods = [
      'selectFrom', 'select', 'selectAll', 'where',
      'insertInto', 'values', 'updateTable', 'set',
      'returningAll', 'executeTakeFirst', 'executeTakeFirstOrThrow',
      'execute', 'orderBy', 'limit', 'offset',
    ];
    for (const method of methods) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }
    chain['executeTakeFirst'] = vi.fn().mockResolvedValue(resolveWith());
    chain['executeTakeFirstOrThrow'] = vi.fn().mockResolvedValue(resolveWith());
    chain['execute'] = vi.fn().mockResolvedValue(resolveWith());
    return chain;
  }

  // Build a more realistic mock database
  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === 'read_state') {
        return createReadStateSelectChain();
      }
      if (table === 'call_history') {
        return createCallHistorySelectChain();
      }
      if (table === 'conversations') {
        return createConversationsSelectChain();
      }
      if (table === 'messages') {
        return createMessagesSelectChain();
      }
      return createQueryChain(() => null);
    }),
    insertInto: vi.fn().mockImplementation(() => {
      return createInsertChain();
    }),
    updateTable: vi.fn().mockImplementation(() => {
      return createUpdateChain();
    }),
    _readStateRows: readStateRows,
    _callHistoryRows: callHistoryRows,
    _conversationRows: conversationRows,
    _messageRows: messageRows,
  };

  function createReadStateSelectChain() {
    let filterType: string | null = null;
    let filterKey: string | null = null;
    const chain: Record<string, unknown> = {};

    chain['select'] = vi.fn().mockReturnValue(chain);
    chain['selectAll'] = vi.fn().mockReturnValue(chain);
    chain['where'] = vi.fn().mockImplementation((_col: string, _op: string, val: unknown) => {
      if (_col === 'item_type') filterType = val as string;
      if (_col === 'item_key') filterKey = val as string;
      return chain;
    });
    chain['executeTakeFirst'] = vi.fn().mockImplementation(() => {
      const match = readStateRows.find(
        (r) => r.item_type === filterType && r.item_key === filterKey
      );
      return Promise.resolve(match ?? null);
    });
    chain['execute'] = vi.fn().mockImplementation(() => {
      let results = readStateRows;
      if (filterType) results = results.filter((r) => r.item_type === filterType);
      if (filterKey) results = results.filter((r) => r.item_key === filterKey);
      return Promise.resolve(results);
    });

    return chain;
  }

  function createCallHistorySelectChain() {
    let filterCallType: string | null = null;
    let filterTimestamp: Date | null = null;
    const chain: Record<string, unknown> = {};

    chain['select'] = vi.fn().mockImplementation((_selectFn: unknown) => {
      // When using countAll, we return chain and let execute resolve to count
      return chain;
    });
    chain['selectAll'] = vi.fn().mockReturnValue(chain);
    chain['where'] = vi.fn().mockImplementation((_col: string, op: string, val: unknown) => {
      if (_col === 'call_type') filterCallType = val as string;
      if (_col === 'timestamp' && op === '>') filterTimestamp = val as Date;
      return chain;
    });
    chain['executeTakeFirstOrThrow'] = vi.fn().mockImplementation(() => {
      let filtered = callHistoryRows;
      if (filterCallType) filtered = filtered.filter((r) => r.call_type === filterCallType);
      if (filterTimestamp) filtered = filtered.filter((r) => r.timestamp > filterTimestamp!);
      return Promise.resolve({ count: String(filtered.length) });
    });
    chain['execute'] = vi.fn().mockImplementation(() => {
      let filtered = callHistoryRows;
      if (filterCallType) filtered = filtered.filter((r) => r.call_type === filterCallType);
      if (filterTimestamp) filtered = filtered.filter((r) => r.timestamp > filterTimestamp!);
      return Promise.resolve(filtered);
    });

    return chain;
  }

  function createConversationsSelectChain() {
    const chain: Record<string, unknown> = {};
    chain['select'] = vi.fn().mockReturnValue(chain);
    chain['selectAll'] = vi.fn().mockReturnValue(chain);
    chain['where'] = vi.fn().mockReturnValue(chain);
    chain['execute'] = vi.fn().mockResolvedValue(conversationRows);
    return chain;
  }

  function createMessagesSelectChain() {
    let filterConv: string | null = null;
    let filterDirection: string | null = null;
    let filterTimestamp: Date | null = null;
    const chain: Record<string, unknown> = {};

    chain['select'] = vi.fn().mockReturnValue(chain);
    chain['selectAll'] = vi.fn().mockReturnValue(chain);
    chain['where'] = vi.fn().mockImplementation((_col: string, op: string, val: unknown) => {
      if (_col === 'conversation_number') filterConv = val as string;
      if (_col === 'direction') filterDirection = val as string;
      if (_col === 'timestamp' && op === '>') filterTimestamp = val as Date;
      return chain;
    });
    chain['executeTakeFirstOrThrow'] = vi.fn().mockImplementation(() => {
      let filtered = messageRows;
      if (filterConv) filtered = filtered.filter((r) => r.conversation_number === filterConv);
      if (filterDirection) filtered = filtered.filter((r) => r.direction === filterDirection);
      if (filterTimestamp) filtered = filtered.filter((r) => r.timestamp > filterTimestamp!);
      return Promise.resolve({ count: String(filtered.length) });
    });
    chain['execute'] = vi.fn().mockImplementation(() => {
      let filtered = messageRows;
      if (filterConv) filtered = filtered.filter((r) => r.conversation_number === filterConv);
      if (filterDirection) filtered = filtered.filter((r) => r.direction === filterDirection);
      if (filterTimestamp) filtered = filtered.filter((r) => r.timestamp > filterTimestamp!);
      return Promise.resolve(filtered);
    });

    return chain;
  }

  function createInsertChain() {
    let insertedValues: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    chain['values'] = vi.fn().mockImplementation((vals: Record<string, unknown>) => {
      insertedValues = vals;
      // Actually add to readStateRows
      if (vals.item_type) {
        readStateRows.push({
          id: `id-${Date.now()}`,
          item_type: vals.item_type as string,
          item_key: vals.item_key as string,
          read_at: (vals.read_at as Date) ?? new Date(),
        });
      }
      return chain;
    });
    chain['execute'] = vi.fn().mockResolvedValue([]);
    chain['returningAll'] = vi.fn().mockReturnValue(chain);
    chain['executeTakeFirstOrThrow'] = vi.fn().mockResolvedValue(insertedValues);
    return chain;
  }

  function createUpdateChain() {
    const chain: Record<string, unknown> = {};
    chain['set'] = vi.fn().mockImplementation((vals: Record<string, unknown>) => {
      // Update matching rows
      if (vals.read_at) {
        // The where clauses will determine what to update
        // For simplicity in tests, we'll update based on tracked state
      }
      return chain;
    });
    chain['where'] = vi.fn().mockReturnValue(chain);
    chain['execute'] = vi.fn().mockResolvedValue([]);
    chain['returningAll'] = vi.fn().mockReturnValue(chain);
    chain['executeTakeFirstOrThrow'] = vi.fn().mockResolvedValue({});
    return chain;
  }

  return db;
}

describe('ReadStateService', () => {
  let service: ReadStateService;
  let mockDb: ReturnType<typeof createMockDb>;
  let broadcastCallback: ReadStateBroadcastCallback;
  let broadcastedEvents: Array<{ event: ReadStateUpdatedEvent; excludeDeviceId?: string }>;

  beforeEach(() => {
    mockDb = createMockDb();
    broadcastedEvents = [];
    broadcastCallback = (event, excludeDeviceId) => {
      broadcastedEvents.push({ event, excludeDeviceId });
    };
    service = new ReadStateService(mockDb as any, broadcastCallback);
  });

  describe('getCounts', () => {
    it('should return zero counts when no data exists', async () => {
      const counts = await service.getCounts();
      expect(counts.unseenMissedCalls).toBe(0);
      expect(counts.unreadMessages).toBe(0);
    });

    it('should count unseen missed calls correctly', async () => {
      // Add some missed calls
      mockDb._callHistoryRows.push(
        { id: '1', call_type: 'MISSED', timestamp: new Date('2024-01-01T10:00:00Z'), phone_number: '+15551234567' },
        { id: '2', call_type: 'MISSED', timestamp: new Date('2024-01-01T11:00:00Z'), phone_number: '+15559876543' },
        { id: '3', call_type: 'INCOMING', timestamp: new Date('2024-01-01T12:00:00Z'), phone_number: '+15551111111' }
      );

      const counts = await service.getCounts();
      expect(counts.unseenMissedCalls).toBe(2); // Only MISSED calls count
    });

    it('should count unread messages across threads', async () => {
      mockDb._conversationRows.push(
        { phone_number: '+15551234567', provider_number: '' },
        { phone_number: '+15559876543', provider_number: '' }
      );
      mockDb._messageRows.push(
        { id: '1', conversation_number: '+15551234567', direction: 'RECEIVED', timestamp: new Date('2024-01-01T10:00:00Z') },
        { id: '2', conversation_number: '+15551234567', direction: 'RECEIVED', timestamp: new Date('2024-01-01T11:00:00Z') },
        { id: '3', conversation_number: '+15559876543', direction: 'RECEIVED', timestamp: new Date('2024-01-01T12:00:00Z') },
        { id: '4', conversation_number: '+15551234567', direction: 'SENT', timestamp: new Date('2024-01-01T13:00:00Z') }
      );

      const counts = await service.getCounts();
      expect(counts.unreadMessages).toBe(3); // Only RECEIVED messages count
    });
  });

  describe('markMissedCallsAsViewed', () => {
    it('should broadcast read_state_updated event', async () => {
      await service.markMissedCallsAsViewed('device-123');

      expect(broadcastedEvents).toHaveLength(1);
      expect(broadcastedEvents[0].event.type).toBe('read_state_updated');
      expect(broadcastedEvents[0].excludeDeviceId).toBe('device-123');
    });

    it('should return updated counts after marking', async () => {
      const counts = await service.markMissedCallsAsViewed();
      expect(counts).toHaveProperty('unseenMissedCalls');
      expect(counts).toHaveProperty('unreadMessages');
    });
  });

  describe('notification hook', () => {
    it('markThreadAsRead should mark the conversation notifications as read', async () => {
      const markConversationRead = vi.fn().mockResolvedValue(2);
      const markAllRead = vi.fn().mockResolvedValue(0);
      const hookedService = new ReadStateService(mockDb as any, broadcastCallback, {
        markConversationRead,
        markAllRead,
      });

      await hookedService.markThreadAsRead('+15550000000', '+15551234567', 'device-1');

      expect(markConversationRead).toHaveBeenCalledWith('+15551234567');
      expect(markAllRead).not.toHaveBeenCalled();
    });

    it('markMissedCallsAsViewed should mark missed/blocked call notifications as read', async () => {
      const markConversationRead = vi.fn().mockResolvedValue(0);
      const markAllRead = vi.fn().mockResolvedValue(3);
      const hookedService = new ReadStateService(mockDb as any, broadcastCallback, {
        markConversationRead,
        markAllRead,
      });

      await hookedService.markMissedCallsAsViewed('device-1');

      expect(markAllRead).toHaveBeenCalledWith(['missed_call', 'blocked_call']);
      expect(markConversationRead).not.toHaveBeenCalled();
    });

    it('should not fail the request if the notification hook throws', async () => {
      const hookedService = new ReadStateService(mockDb as any, broadcastCallback, {
        markConversationRead: vi.fn().mockRejectedValue(new Error('db down')),
        markAllRead: vi.fn().mockRejectedValue(new Error('db down')),
      });

      // Both should resolve to counts despite the hook rejecting
      await expect(hookedService.markThreadAsRead('+15550000000', '+15551234567')).resolves.toHaveProperty('unreadMessages');
      await expect(hookedService.markMissedCallsAsViewed()).resolves.toHaveProperty('unseenMissedCalls');
    });

    it('should still work when no notification hook is provided', async () => {
      // service (from beforeEach) has no hook — must not throw
      await expect(service.markThreadAsRead('+15550000000', '+15551234567')).resolves.toHaveProperty('unreadMessages');
    });
  });

  describe('markThreadAsRead', () => {
    it('should broadcast read_state_updated event with excludeDeviceId', async () => {
      await service.markThreadAsRead('+15550000000', '+15551234567', 'device-456');

      expect(broadcastedEvents).toHaveLength(1);
      expect(broadcastedEvents[0].event.type).toBe('read_state_updated');
      expect(broadcastedEvents[0].excludeDeviceId).toBe('device-456');
    });

    it('should handle marking without excludeDeviceId', async () => {
      await service.markThreadAsRead('+15550000000', '+15551234567');

      expect(broadcastedEvents).toHaveLength(1);
      expect(broadcastedEvents[0].excludeDeviceId).toBeUndefined();
    });

    it('should return counts structure', async () => {
      const counts = await service.markThreadAsRead('+15550000000', '+15551234567');
      expect(typeof counts.unreadMessages).toBe('number');
      expect(typeof counts.unseenMissedCalls).toBe('number');
    });
  });
});
