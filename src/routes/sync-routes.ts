import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';

/**
 * Register sync routes for full state sync fallback.
 */
export function registerSyncRoutes(
  server: FastifyInstance,
  db: Kysely<Database>
): void {
  /**
   * GET /api/sync/state
   * Returns full state (all numbers, recent call history, recent conversations)
   * as a JSON blob for initial sync or fallback polling.
   * Protected by session middleware (requires valid session token).
   */
  server.get('/api/sync/state', async (_request: FastifyRequest, reply: FastifyReply) => {
    const [numbers, callHistory, conversations] = await Promise.all([
      // All active numbers with labels
      db
        .selectFrom('numbers')
        .selectAll()
        .where('is_active', '=', true)
        .orderBy('last_used_at', 'desc')
        .execute(),

      // Recent call history (last 50 entries)
      db
        .selectFrom('call_history')
        .selectAll()
        .orderBy('timestamp', 'desc')
        .limit(50)
        .execute(),

      // Recent conversations with last message info
      db
        .selectFrom('conversations')
        .selectAll()
        .orderBy('last_message_timestamp', 'desc')
        .limit(50)
        .execute(),
    ]);

    return reply.status(200).send({
      numbers: numbers.map((n) => ({
        number: n.number,
        label: n.label,
        isActive: n.is_active,
        lastUsedAt: n.last_used_at?.toISOString() ?? null,
      })),
      callHistory: callHistory.map((c) => ({
        id: c.id,
        phoneNumber: c.phone_number,
        providerNumber: c.provider_number,
        callType: c.call_type,
        timestamp: c.timestamp.toISOString(),
        durationSeconds: c.duration_seconds,
        answeredByDevice: c.answered_by_device,
        realCallerNumber: c.real_caller_number,
      })),
      conversations: conversations.map((c) => ({
        phoneNumber: c.phone_number,
        lastMessagePreview: c.last_message_preview,
        lastMessageTimestamp: c.last_message_timestamp?.toISOString() ?? null,
      })),
    });
  });
}
