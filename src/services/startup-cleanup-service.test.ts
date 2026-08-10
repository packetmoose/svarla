import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StartupCleanupService } from './startup-cleanup-service.js';
import type { StartupCleanupLogger } from './startup-cleanup-service.js';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';

function createMockLogger(): StartupCleanupLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as StartupCleanupLogger;
}

/**
 * Creates a mock database that tracks update operations.
 * Each updateTable call returns a chainable mock that records
 * the table, set values, and where conditions.
 */
function createMockDb(options: { throwOnTable?: string } = {}) {
  const updates: Array<{
    table: string;
    setValues: Record<string, unknown>;
    conditions: Array<{ column: string; op: string; value: unknown }>;
    numUpdatedRows: bigint;
  }> = [];

  // Track how many rows each update "affects"
  let missedCallsCount = 3n;
  let unansweredCallsCount = 2n;
  let notificationsCount = 1n;

  const mockDb = {
    updateTable: vi.fn().mockImplementation((table: string) => {
      if (options.throwOnTable === table) {
        // Return a chain that will throw when executed
        const throwChain: any = {
          set: () => throwChain,
          where: () => throwChain,
          executeTakeFirst: async () => {
            throw new Error(`Database error on table: ${table}`);
          },
        };
        return throwChain;
      }

      const update: {
        table: string;
        setValues: Record<string, unknown>;
        conditions: Array<{ column: string; op: string; value: unknown }>;
        numUpdatedRows: bigint;
      } = {
        table,
        setValues: {},
        conditions: [],
        numUpdatedRows: 0n,
      };

      const chain: any = {
        set: (values: Record<string, unknown>) => {
          update.setValues = values;
          return chain;
        },
        where: (column: string, op: string, value: unknown) => {
          update.conditions.push({ column, op, value });
          return chain;
        },
        executeTakeFirst: async () => {
          let numRows: bigint;
          if (table === 'call_history') {
            const isMissed = update.conditions.some(
              (c) => c.column === 'call_type' && c.value === 'INCOMING'
            );
            numRows = isMissed ? missedCallsCount : unansweredCallsCount;
          } else {
            numRows = notificationsCount;
          }
          update.numUpdatedRows = numRows;
          updates.push(update);
          return { numUpdatedRows: numRows };
        },
      };

      return chain;
    }),
  } as unknown as Kysely<Database>;

  return {
    mockDb,
    getUpdates: () => updates,
    setCounts: (missed: bigint, unanswered: bigint, notifications: bigint) => {
      missedCallsCount = missed;
      unansweredCallsCount = unanswered;
      notificationsCount = notifications;
    },
  };
}

describe('StartupCleanupService', () => {
  let service: StartupCleanupService;
  let logger: StartupCleanupLogger;
  let dbHelper: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    logger = createMockLogger();
    dbHelper = createMockDb();
    service = new StartupCleanupService({ db: dbHelper.mockDb, logger });
  });

  describe('run', () => {
    it('should mark stale INCOMING calls as MISSED', async () => {
      await service.run();

      const updates = dbHelper.getUpdates();
      const missedUpdate = updates.find(
        (u) =>
          u.table === 'call_history' &&
          u.setValues.call_type === 'MISSED'
      );

      expect(missedUpdate).toBeDefined();
      expect(missedUpdate!.conditions).toEqual(
        expect.arrayContaining([
          { column: 'call_type', op: '=', value: 'INCOMING' },
          { column: 'answered_by_device', op: 'is', value: null },
        ])
      );
    });

    it('should mark stale OUTGOING calls as UNANSWERED', async () => {
      await service.run();

      const updates = dbHelper.getUpdates();
      const unansweredUpdate = updates.find(
        (u) =>
          u.table === 'call_history' &&
          u.setValues.call_type === 'UNANSWERED'
      );

      expect(unansweredUpdate).toBeDefined();
      expect(unansweredUpdate!.conditions).toEqual(
        expect.arrayContaining([
          { column: 'call_type', op: '=', value: 'OUTGOING' },
          { column: 'duration_seconds', op: 'is', value: null },
        ])
      );
    });

    it('should transition pending incoming_call notifications to missed_call', async () => {
      await service.run();

      const updates = dbHelper.getUpdates();
      const notificationUpdate = updates.find(
        (u) => u.table === 'notifications'
      );

      expect(notificationUpdate).toBeDefined();
      expect(notificationUpdate!.setValues.type).toBe('missed_call');
      expect(notificationUpdate!.setValues.updated_at).toBeInstanceOf(Date);
      expect(notificationUpdate!.conditions).toEqual(
        expect.arrayContaining([
          { column: 'type', op: '=', value: 'incoming_call' },
          { column: 'status', op: '=', value: 'pending' },
        ])
      );
    });

    it('should log counts of affected rows', async () => {
      dbHelper.setCounts(5n, 3n, 2n);

      await service.run();

      expect(logger.info).toHaveBeenCalledWith(
        { count: 5 },
        expect.stringContaining('5')
      );
      expect(logger.info).toHaveBeenCalledWith(
        { count: 3 },
        expect.stringContaining('3')
      );
      expect(logger.info).toHaveBeenCalledWith(
        { count: 2 },
        expect.stringContaining('2')
      );
    });

    it('should handle zero affected rows gracefully', async () => {
      dbHelper.setCounts(0n, 0n, 0n);

      await service.run();

      const updates = dbHelper.getUpdates();
      expect(updates).toHaveLength(3);
      expect(logger.info).toHaveBeenCalledWith(
        { count: 0 },
        expect.stringContaining('0')
      );
    });

    it('should throw on database error (call_history INCOMING)', async () => {
      const failingDb = createMockDb({ throwOnTable: 'call_history' });
      const failingService = new StartupCleanupService({
        db: failingDb.mockDb,
        logger,
      });

      await expect(failingService.run()).rejects.toThrow('Database error on table: call_history');
    });

    it('should throw on database error (notifications)', async () => {
      const failingDb = createMockDb({ throwOnTable: 'notifications' });
      const failingService = new StartupCleanupService({
        db: failingDb.mockDb,
        logger,
      });

      await expect(failingService.run()).rejects.toThrow('Database error on table: notifications');
    });

    it('should execute all three updates in order', async () => {
      await service.run();

      const updates = dbHelper.getUpdates();
      expect(updates).toHaveLength(3);

      // First: INCOMING → MISSED
      expect(updates[0].table).toBe('call_history');
      expect(updates[0].setValues.call_type).toBe('MISSED');

      // Second: OUTGOING → UNANSWERED
      expect(updates[1].table).toBe('call_history');
      expect(updates[1].setValues.call_type).toBe('UNANSWERED');

      // Third: incoming_call notifications → missed_call
      expect(updates[2].table).toBe('notifications');
      expect(updates[2].setValues.type).toBe('missed_call');
    });
  });
});
