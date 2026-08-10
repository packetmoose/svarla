import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { NumberManagementService } from '../services/number-management-service.js';

const updateLabelSchema = z.object({
  label: z.string().min(1, 'Label is required').max(30, 'Label must be at most 30 characters'),
});

const setActiveSchema = z.object({
  active: z.boolean(),
});

const setBlockInboundSchema = z.object({
  block: z.boolean(),
});

/**
 * Register number management routes.
 * All routes require session authentication (handled by session middleware).
 */
export function registerNumberRoutes(
  server: FastifyInstance,
  numberService: NumberManagementService
): void {
  /**
   * GET /api/numbers
   * List all numbers with labels and provider context.
   */
  server.get('/api/numbers', async (_request: FastifyRequest, reply: FastifyReply) => {
    const numbers = await numberService.getAllNumbers();

    return reply.status(200).send({
      numbers: numbers.map((n) => ({
        number: n.number,
        label: n.label,
        color: n.color,
        addedAt: n.added_at.toISOString(),
        isActive: n.is_active,
        lastUsedAt: n.last_used_at?.toISOString() ?? null,
        providerId: n.provider_id,
        providerDisplayName: n.provider_display_name ?? null,
        blockInboundCalls: n.block_inbound_calls,
      })),
      defaultNumber: (await numberService.getDefaultNumber())?.number ?? null,
    });
  });

  /**
   * PUT /api/numbers/:number/label
   * Update the label for a Vonage number.
   */
  server.put('/api/numbers/:number/label', async (request: FastifyRequest, reply: FastifyReply) => {
    const { number } = request.params as { number: string };

    const parseResult = updateLabelSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.issues.map((i) => i.message),
        statusCode: 400,
      });
    }

    const { label } = parseResult.data;
    const result = await numberService.updateLabel(number, label);

    if (!result.success) {
      return reply.status(404).send({
        error: result.error,
        statusCode: 404,
      });
    }

    return reply.status(200).send({
      message: 'Label updated successfully',
      number,
      label,
    });
  });

  /**
   * POST /api/numbers/sync
   * Trigger a sync of numbers from the telephony provider.
   * Optionally accepts { providerId } in body; if missing, syncs all providers.
   */
  server.post('/api/numbers/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { providerId?: string } | null;
    const providerId = body?.providerId;

    if (providerId) {
      try {
        const result = await numberService.syncNumbers(providerId);
        return reply.status(200).send({
          message: 'Sync completed',
          added: result.added,
          removed: result.removed,
          total: result.total,
        });
      } catch (err) {
        request.log.error(err, `Failed to sync numbers for provider ${providerId}`);
        const message = err instanceof Error ? err.message : 'Unknown error during sync';
        return reply.status(502).send({
          error: `Number sync failed: ${message}`,
          statusCode: 502,
        });
      }
    }

    // If no providerId provided, return error (caller must specify)
    return reply.status(400).send({
      error: 'providerId is required',
      statusCode: 400,
    });
  });

  /**
   * PUT /api/numbers/:number/active
   * Activate or deactivate a number.
   */
  server.put('/api/numbers/:number/active', async (request: FastifyRequest, reply: FastifyReply) => {
    const { number } = request.params as { number: string };

    const parseResult = setActiveSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.issues.map((i) => i.message),
        statusCode: 400,
      });
    }

    const { active } = parseResult.data;
    const result = await numberService.setActive(number, active);

    if (!result.success) {
      return reply.status(404).send({
        error: result.error,
        statusCode: 404,
      });
    }

    return reply.status(200).send({
      message: active ? 'Number activated' : 'Number deactivated',
      number,
      active,
    });
  });

  /**
   * PUT /api/numbers/:number/block-inbound
   * Enable or disable blocking of incoming calls for a number.
   * When blocked, callers will hear a voice message telling them to send a text.
   */
  server.put('/api/numbers/:number/block-inbound', async (request: FastifyRequest, reply: FastifyReply) => {
    const { number } = request.params as { number: string };

    const parseResult = setBlockInboundSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.issues.map((i) => i.message),
        statusCode: 400,
      });
    }

    const { block } = parseResult.data;
    const result = await numberService.setBlockInboundCalls(number, block);

    if (!result.success) {
      return reply.status(404).send({
        error: result.error,
        statusCode: 404,
      });
    }

    return reply.status(200).send({
      message: block ? 'Incoming calls blocked' : 'Incoming calls unblocked',
      number,
      blockInboundCalls: block,
    });
  });

  /**
   * PUT /api/numbers/default
   * Set the default number for outbound calls and SMS.
   * Pass { number: null } to clear the preference.
   */
  server.put('/api/numbers/default', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { number: string | null } | null;

    if (body === null || body.number === undefined) {
      return reply.status(400).send({
        error: 'Request body must include "number" field (string or null)',
        statusCode: 400,
      });
    }

    const result = await numberService.setDefaultNumber(body.number);

    if (!result.success) {
      return reply.status(404).send({
        error: result.error,
        statusCode: 404,
      });
    }

    return reply.status(200).send({
      message: body.number ? `Default number set to ${body.number}` : 'Default number preference cleared',
      defaultNumber: body.number,
    });
  });
}
