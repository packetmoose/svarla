import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ReadStateService } from '../services/read-state-service.js';

/**
 * Register read-state routes for Global_Read_State management.
 * All routes require session authentication (handled by session middleware).
 *
 * Requirements covered: 15.1-15.12
 */
export function registerReadStateRoutes(
  server: FastifyInstance,
  readStateService: ReadStateService
): void {
  /**
   * GET /api/read-state/counts
   * Returns the current badge counts: { unreadMessages, unseenMissedCalls }
   */
  server.get('/api/read-state/counts', async (_request: FastifyRequest, reply: FastifyReply) => {
    const counts = await readStateService.getCounts();
    return reply.status(200).send(counts);
  });

  /**
   * POST /api/read-state/calls
   * Mark all missed calls as viewed.
   * Broadcasts read_state_updated to all other devices.
   */
  server.post('/api/read-state/calls', async (request: FastifyRequest, reply: FastifyReply) => {
    const deviceId = request.deviceId;
    const counts = await readStateService.markMissedCallsAsViewed(deviceId);
    return reply.status(200).send(counts);
  });

  /**
   * POST /api/read-state/messages/:number
   * Mark all messages in a thread as read.
   * Broadcasts read_state_updated to all other devices.
   */
  server.post('/api/read-state/messages/:number', async (request: FastifyRequest, reply: FastifyReply) => {
    const { number } = request.params as { number: string };

    if (!number || number.trim() === '') {
      return reply.status(400).send({
        error: 'Phone number is required',
        statusCode: 400,
      });
    }

    const deviceId = request.deviceId;
    const counts = await readStateService.markThreadAsRead(number, deviceId);
    return reply.status(200).send(counts);
  });
}
