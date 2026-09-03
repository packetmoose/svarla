import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ConversationService } from '../services/conversation-service.js';
import type { NumberManagementService } from '../services/number-management-service.js';
import { validateMessage } from '../validators/message-validator.js';
import { validatePhoneNumber } from '../validators/phone-number-validator.js';

/**
 * Register SMS and conversation routes.
 * All routes require session authentication (handled by session middleware).
 */
export function registerSmsRoutes(
  server: FastifyInstance,
  conversationService: ConversationService,
  numberManagementService?: NumberManagementService
): void {
  /**
   * POST /api/sms/send
   * Send an outbound SMS message.
   * Body: { to: string, body: string, from: string }
   * Returns the created message.
   */
  server.post('/api/sms/send', async (request: FastifyRequest, reply: FastifyReply) => {
    const { to, body, from } = request.body as { to?: string; body?: string; from?: string };

    server.log.info({ to, body: body?.slice(0, 50), from }, 'POST /api/sms/send received');

    if (!to || !body || !from) {
      return reply.status(400).send({
        error: 'Missing required fields: to, body, from',
        statusCode: 400,
      });
    }

    // Validate message body (length, not whitespace-only)
    const bodyValidation = validateMessage(body);
    if (!bodyValidation.valid) {
      return reply.status(400).send({
        error: bodyValidation.error,
        statusCode: 400,
      });
    }

    // Validate destination number format
    const toValidation = validatePhoneNumber(to);
    if (!toValidation.valid) {
      return reply.status(400).send({
        error: toValidation.error,
        statusCode: 400,
      });
    }

    // Validate that the 'from' number belongs to the user (is a registered active number)
    if (numberManagementService) {
      const providerForNumber = await numberManagementService.getProviderForNumber(from);
      if (!providerForNumber) {
        return reply.status(403).send({
          error: 'The "from" number is not a registered active number',
          statusCode: 403,
        });
      }
    }

    try {
      const message = await conversationService.sendMessage(from, to, body);

      return reply.status(201).send({
        id: message.id,
        providerMessageId: message.provider_message_id,
        conversationNumber: message.conversation_number,
        providerNumber: message.provider_number,
        body: message.body,
        direction: message.direction,
        status: message.status,
        timestamp: message.timestamp.toISOString(),
        retryCount: message.retry_count,
      });
    } catch (err) {
      server.log.error(err, 'POST /api/sms/send error');
      const errorMessage = err instanceof Error ? err.message : 'Failed to send message';
      return reply.status(500).send({
        error: errorMessage,
        statusCode: 500,
      });
    }
  });

  /**
   * GET /api/conversations
   * List conversation threads, paginated, ordered by most recent message.
   * Query params: page (default 1), pageSize (default 50, max 100)
   */
  server.get('/api/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { page?: string; pageSize?: string; providerNumber?: string };

    const page = Math.max(parseInt(query.page ?? '1', 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize ?? '50', 10) || 50, 1), 100);
    const providerNumber = query.providerNumber || undefined;

    const result = await conversationService.getConversations(page, pageSize, providerNumber);

    // Fetch per-thread read state
    const phoneNumbers = result.conversations.map((c) => c.phone_number);
    const readStates = await conversationService.getThreadReadStates(phoneNumbers);
    const lastReceivedTimes = await conversationService.getLastReceivedTimestamps(phoneNumbers);

    return reply.status(200).send({
      conversations: result.conversations.map((c) => ({
        phoneNumber: c.phone_number,
        providerNumber: c.provider_number,
        lastMessagePreview: c.last_message_preview,
        lastMessageTimestamp: c.last_message_timestamp?.toISOString() ?? null,
        lastReceivedAt: lastReceivedTimes.get(c.phone_number)?.toISOString() ?? null,
        createdAt: c.created_at.toISOString(),
        lastReadAt: readStates.get(c.phone_number)?.toISOString() ?? null,
      })),
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    });
  });

  /**
   * GET /api/conversations/:number
   * Get last 100 messages for a conversation thread.
   * Param: number — the E.164 phone number identifying the thread.
   */
  server.get('/api/conversations/:number', async (request: FastifyRequest, reply: FastifyReply) => {
    const { number } = request.params as { number: string };
    const query = request.query as { limit?: string; from?: string };

    if (!number || number.trim() === '') {
      return reply.status(400).send({
        error: 'Phone number parameter is required',
        statusCode: 400,
      });
    }

    // URL-decode the number parameter (+ is encoded as %2B in URLs)
    const decodedNumber = decodeURIComponent(number);

    // Optional filters: limit caps the result count; `from` scopes messages to a
    // single conversation thread by its provider (own) number so that two
    // conversations with the same recipient but different own-numbers stay separate.
    const limit = Math.min(Math.max(parseInt(query.limit ?? '100', 10) || 100, 1), 100);
    const providerNumber = query.from && query.from.trim() !== '' ? query.from : undefined;

    const messages = await conversationService.getMessages(decodedNumber, limit, providerNumber);

    return reply.status(200).send({
      phoneNumber: decodedNumber,
      messages: messages.map((m) => ({
        id: m.id,
        providerMessageId: m.provider_message_id,
        conversationNumber: m.conversation_number,
        providerNumber: m.provider_number,
        body: m.body,
        direction: m.direction,
        status: m.status,
        timestamp: m.timestamp.toISOString(),
        retryCount: m.retry_count,
      })),
    });
  });

  /**
   * DELETE /api/conversations/:number
   * Mark a conversation as removed. It won't appear in the conversation list.
   * Does not permanently delete messages.
   */
  server.delete('/api/conversations/:number', async (request: FastifyRequest, reply: FastifyReply) => {
    const { number } = request.params as { number: string };

    if (!number || number.trim() === '') {
      return reply.status(400).send({
        error: 'Phone number parameter is required',
        statusCode: 400,
      });
    }

    const decodedNumber = decodeURIComponent(number);

    try {
      await conversationService.removeConversation(decodedNumber);
      return reply.status(200).send({ success: true });
    } catch (err) {
      server.log.error(err, 'DELETE /api/conversations/:number error');
      return reply.status(500).send({
        error: 'Failed to remove conversation',
        statusCode: 500,
      });
    }
  });

  /**
   * DELETE /api/messages/:id
   * Mark a single message as removed. It won't be returned in conversation messages.
   * Does not permanently delete the message.
   */
  server.delete('/api/messages/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    if (!id || id.trim() === '') {
      return reply.status(400).send({
        error: 'Message ID parameter is required',
        statusCode: 400,
      });
    }

    try {
      await conversationService.removeMessage(id);
      return reply.status(200).send({ success: true });
    } catch (err) {
      server.log.error(err, 'DELETE /api/messages/:id error');
      return reply.status(500).send({
        error: 'Failed to remove message',
        statusCode: 500,
      });
    }
  });

  /**
   * POST /api/messages/:id/restore
   * Restore a previously removed message (undo removal).
   */
  server.post('/api/messages/:id/restore', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    if (!id || id.trim() === '') {
      return reply.status(400).send({
        error: 'Message ID parameter is required',
        statusCode: 400,
      });
    }

    try {
      await conversationService.restoreMessage(id);
      return reply.status(200).send({ success: true });
    } catch (err) {
      server.log.error(err, 'POST /api/messages/:id/restore error');
      return reply.status(500).send({
        error: 'Failed to restore message',
        statusCode: 500,
      });
    }
  });
}
