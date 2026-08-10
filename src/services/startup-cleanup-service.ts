import type { Kysely } from 'kysely';
import type { Database } from '../database.js';

/**
 * Logger interface compatible with Fastify/Pino logger.
 */
export interface StartupCleanupLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface StartupCleanupServiceDeps {
  db: Kysely<Database>;
  logger: StartupCleanupLogger;
}

/**
 * Service that runs on server startup to reconcile stale call history entries
 * and their associated notifications. Must complete before the server begins
 * accepting connections.
 *
 * If any database operation fails, the error propagates to abort startup.
 */
export class StartupCleanupService {
  private readonly db: Kysely<Database>;
  private readonly logger: StartupCleanupLogger;

  constructor(deps: StartupCleanupServiceDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
  }

  /**
   * Run all cleanup operations. Must complete before server accepts connections.
   * Throws on database errors to abort startup.
   */
  async run(): Promise<void> {
    this.logger.info('Starting startup cleanup...');

    // 1. Mark all INCOMING calls with no answered device as MISSED
    const missedCallsResult = await this.db
      .updateTable('call_history')
      .set({ call_type: 'MISSED' })
      .where('call_type', '=', 'INCOMING')
      .where('answered_by_device', 'is', null)
      .executeTakeFirst();

    const missedCallsCount = Number(missedCallsResult.numUpdatedRows);
    this.logger.info(
      { count: missedCallsCount },
      `Marked ${missedCallsCount} stale incoming calls as MISSED`
    );

    // 2. Mark all OUTGOING calls with no duration as UNANSWERED
    const unansweredCallsResult = await this.db
      .updateTable('call_history')
      .set({ call_type: 'UNANSWERED' })
      .where('call_type', '=', 'OUTGOING')
      .where('duration_seconds', 'is', null)
      .executeTakeFirst();

    const unansweredCallsCount = Number(unansweredCallsResult.numUpdatedRows);
    this.logger.info(
      { count: unansweredCallsCount },
      `Marked ${unansweredCallsCount} stale outgoing calls as UNANSWERED`
    );

    // 3. Transition all pending incoming_call notifications to missed_call
    const notificationsResult = await (this.db as Kysely<any>)
      .updateTable('notifications')
      .set({ type: 'missed_call', updated_at: new Date() })
      .where('type', '=', 'incoming_call')
      .where('status', '=', 'pending')
      .executeTakeFirst();

    const notificationsCount = Number(notificationsResult.numUpdatedRows);
    this.logger.info(
      { count: notificationsCount },
      `Transitioned ${notificationsCount} pending incoming_call notifications to missed_call`
    );

    this.logger.info('Startup cleanup completed successfully');
  }
}
