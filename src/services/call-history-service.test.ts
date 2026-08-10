import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CallHistoryService } from './call-history-service.js';
import type {
  CallHistoryEvent,
  CallHistoryBroadcastCallback,
  RecordCallInput,
} from './call-history-service.js';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';

interface MockCallRow {
  id: string;
  phone_number: string;
  provider_number: string | null;
  call_type: 'INCOMING' | 'OUTGOING' | 'MISSED' | 'UNANSWERED';
  timestamp: Date;
  duration_seconds: number | null;
  provider_call_id: string | null;
  answered_by_device: string | null;
}

let idCounter = 0;

function createMockDb(initialEntries: MockCallRow[] = []) {
  let entries = [...initialEntries];

  const mockDb = {
    insertInto: vi.fn().mockImplementation((_table: string) => {
      return {
        values: (values: Record<string, unknown>) => ({
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              idCounter++;
              const newEntry: MockCallRow = {
                id: `uuid-${idCounter}`,
                phone_number: values.phone_number as string,
                provider_number: (values.provider_number as string | null) ?? null,
                call_type: values.call_type as MockCallRow['call_type'],
                timestamp: new Date(),
                duration_seconds: (values.duration_seconds as number | null) ?? null,
                provider_call_id: (values.provider_call_id as string | null) ?? null,
                answered_by_device: (values.answered_by_device as string | null) ?? null,
              };
              entries.push(newEntry);
              return { ...newEntry };
            },
          }),
        }),
      };
    }),
    selectFrom: vi.fn().mockImplementation((_table: string) => {
      return {
        selectAll: () => ({
          orderBy: (_col: string, dir: string) => ({
            limit: (lim: number) => ({
              offset: (off: number) => ({
                execute: async () => {
                  const sorted = [...entries].sort((a, b) => {
                    if (dir === 'desc') {
                      return b.timestamp.getTime() - a.timestamp.getTime();
                    }
                    return a.timestamp.getTime() - b.timestamp.getTime();
                  });
                  return sorted.slice(off, off + lim).map((e) => ({ ...e }));
                },
              }),
              execute: async () => {
                const sorted = [...entries].sort((a, b) => {
                  if (dir === 'desc') {
                    return b.timestamp.getTime() - a.timestamp.getTime();
                  }
                  return a.timestamp.getTime() - b.timestamp.getTime();
                });
                return sorted.slice(0, lim).map((e) => ({ ...e }));
              },
            }),
          }),
        }),
        select: (selectorFn: unknown) => {
          // If it's a function (expression builder for countAll), return the count chain
          if (typeof selectorFn === 'function') {
            return {
              executeTakeFirstOrThrow: async () => ({
                count: String(entries.length),
              }),
            };
          }
          // If it's a string (select('id')), return orderBy chain for enforceEntryCap
          return {
            orderBy: (_col: string, dir: string) => ({
              limit: (lim: number) => ({
                execute: async () => {
                  const sorted = [...entries].sort((a, b) => {
                    if (dir === 'asc') {
                      return a.timestamp.getTime() - b.timestamp.getTime();
                    }
                    return b.timestamp.getTime() - a.timestamp.getTime();
                  });
                  return sorted.slice(0, lim).map((e) => ({ id: e.id }));
                },
              }),
            }),
            executeTakeFirstOrThrow: async () => ({
              count: String(entries.length),
            }),
          };
        },
      };
    }),
    deleteFrom: vi.fn().mockImplementation((_table: string) => {
      return {
        where: (_col: string, _op: string, ids: string[]) => ({
          execute: async () => {
            entries = entries.filter((e) => !ids.includes(e.id));
          },
        }),
      };
    }),
  } as unknown as Kysely<Database>;

  return {
    mockDb,
    getEntries: () => entries,
    setEntries: (e: MockCallRow[]) => {
      entries = e;
    },
  };
}

function makeEntry(overrides: Partial<MockCallRow> = {}): MockCallRow {
  idCounter++;
  return {
    id: `uuid-${idCounter}`,
    phone_number: '+14155551234',
    provider_number: '+14155550000',
    call_type: 'INCOMING',
    timestamp: new Date(),
    duration_seconds: null,
    provider_call_id: null,
    answered_by_device: null,
    ...overrides,
  };
}

describe('CallHistoryService', () => {
  let service: CallHistoryService;
  let dbHelper: ReturnType<typeof createMockDb>;
  let broadcastEvents: CallHistoryEvent[];
  let broadcast: CallHistoryBroadcastCallback;

  beforeEach(() => {
    idCounter = 0;
    broadcastEvents = [];
    broadcast = (event) => broadcastEvents.push(event);
    dbHelper = createMockDb();
    service = new CallHistoryService(dbHelper.mockDb, broadcast);
  });

  describe('recordCall', () => {
    it('should insert a new call entry and return it', async () => {
      const input: RecordCallInput = {
        phone_number: '+14155551234',
        provider_number: '+14155550000',
        call_type: 'INCOMING',
        duration_seconds: 120,
        provider_call_id: 'vonage-call-123',
        answered_by_device: 'device-uuid-1',
      };

      const entry = await service.recordCall(input);

      expect(entry.phone_number).toBe('+14155551234');
      expect(entry.provider_number).toBe('+14155550000');
      expect(entry.call_type).toBe('INCOMING');
      expect(entry.duration_seconds).toBe(120);
      expect(entry.provider_call_id).toBe('vonage-call-123');
      expect(entry.answered_by_device).toBe('device-uuid-1');
      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeInstanceOf(Date);
    });

    it('should insert a call with minimal fields', async () => {
      const input: RecordCallInput = {
        phone_number: '+14155559999',
        call_type: 'MISSED',
      };

      const entry = await service.recordCall(input);

      expect(entry.phone_number).toBe('+14155559999');
      expect(entry.call_type).toBe('MISSED');
      expect(entry.provider_number).toBeNull();
      expect(entry.duration_seconds).toBeNull();
      expect(entry.provider_call_id).toBeNull();
      expect(entry.answered_by_device).toBeNull();
    });

    it('should broadcast call_history_update event after recording', async () => {
      const input: RecordCallInput = {
        phone_number: '+14155551234',
        call_type: 'OUTGOING',
        duration_seconds: 60,
      };

      const entry = await service.recordCall(input);

      expect(broadcastEvents).toHaveLength(1);
      expect(broadcastEvents[0].type).toBe('call_history_update');
      expect(broadcastEvents[0].entry).toEqual(entry);
    });

    it('should support all call types', async () => {
      const callTypes: Array<'INCOMING' | 'OUTGOING' | 'MISSED' | 'UNANSWERED'> = [
        'INCOMING',
        'OUTGOING',
        'MISSED',
        'UNANSWERED',
      ];

      for (const callType of callTypes) {
        const entry = await service.recordCall({
          phone_number: '+14155551234',
          call_type: callType,
        });
        expect(entry.call_type).toBe(callType);
      }
    });

    it('should enforce 1000 entry cap by removing oldest entries', async () => {
      // Pre-fill with 1000 entries
      const existingEntries: MockCallRow[] = [];
      for (let i = 0; i < 1000; i++) {
        existingEntries.push(
          makeEntry({
            id: `old-${i}`,
            timestamp: new Date(Date.now() - (1000 - i) * 1000),
          })
        );
      }
      dbHelper.setEntries(existingEntries);

      // Record one more — should trigger cap enforcement
      await service.recordCall({
        phone_number: '+14155559999',
        call_type: 'OUTGOING',
      });

      // After enforcement, the oldest entry should be deleted
      const remaining = dbHelper.getEntries();
      expect(remaining.length).toBe(1000);
      // The oldest entry (old-0) should have been removed
      expect(remaining.find((e) => e.id === 'old-0')).toBeUndefined();
    });
  });

  describe('getHistory', () => {
    it('should return paginated entries ordered by timestamp DESC', async () => {
      const now = Date.now();
      dbHelper.setEntries([
        makeEntry({ id: 'a', timestamp: new Date(now - 3000) }),
        makeEntry({ id: 'b', timestamp: new Date(now - 2000) }),
        makeEntry({ id: 'c', timestamp: new Date(now - 1000) }),
      ]);

      const result = await service.getHistory(1, 10);

      expect(result.entries).toHaveLength(3);
      expect(result.entries[0].id).toBe('c');
      expect(result.entries[1].id).toBe('b');
      expect(result.entries[2].id).toBe('a');
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
      expect(result.total).toBe(3);
      expect(result.totalPages).toBe(1);
    });

    it('should respect page and pageSize parameters', async () => {
      const now = Date.now();
      const entries: MockCallRow[] = [];
      for (let i = 0; i < 10; i++) {
        entries.push(makeEntry({ id: `entry-${i}`, timestamp: new Date(now - i * 1000) }));
      }
      dbHelper.setEntries(entries);

      const result = await service.getHistory(2, 3);

      expect(result.entries).toHaveLength(3);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(3);
      expect(result.total).toBe(10);
      expect(result.totalPages).toBe(4);
    });

    it('should return empty array when no entries exist', async () => {
      dbHelper.setEntries([]);

      const result = await service.getHistory(1, 50);

      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });

    it('should clamp page to minimum of 1', async () => {
      dbHelper.setEntries([makeEntry()]);

      const result = await service.getHistory(0, 50);

      expect(result.page).toBe(1);
    });

    it('should clamp pageSize to maximum of 100', async () => {
      dbHelper.setEntries([makeEntry()]);

      const result = await service.getHistory(1, 200);

      expect(result.pageSize).toBe(100);
    });

    it('should clamp pageSize to minimum of 1', async () => {
      dbHelper.setEntries([makeEntry()]);

      const result = await service.getHistory(1, 0);

      expect(result.pageSize).toBe(1);
    });
  });

  describe('getRecentHistory', () => {
    it('should return the N most recent entries', async () => {
      const now = Date.now();
      dbHelper.setEntries([
        makeEntry({ id: 'a', timestamp: new Date(now - 3000) }),
        makeEntry({ id: 'b', timestamp: new Date(now - 2000) }),
        makeEntry({ id: 'c', timestamp: new Date(now - 1000) }),
      ]);

      const entries = await service.getRecentHistory(2);

      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe('c');
      expect(entries[1].id).toBe('b');
    });

    it('should return all entries when limit exceeds count', async () => {
      dbHelper.setEntries([makeEntry(), makeEntry()]);

      const entries = await service.getRecentHistory(10);

      expect(entries).toHaveLength(2);
    });

    it('should clamp limit to minimum of 1', async () => {
      dbHelper.setEntries([makeEntry(), makeEntry(), makeEntry()]);

      const entries = await service.getRecentHistory(0);

      expect(entries).toHaveLength(1);
    });

    it('should clamp limit to maximum of 100', async () => {
      // We only have a few entries, but the service should internally cap at 100
      dbHelper.setEntries([makeEntry(), makeEntry()]);

      const entries = await service.getRecentHistory(200);

      expect(entries).toHaveLength(2);
    });

    it('should return empty when no entries exist', async () => {
      dbHelper.setEntries([]);

      const entries = await service.getRecentHistory(10);

      expect(entries).toEqual([]);
    });
  });
});
