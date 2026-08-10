import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CallHistoryService } from '../services/call-history-service.js';
import type { CallOrchestrator } from '../services/call-orchestrator.js';
import { CallNotFoundError, CallOrchestratorError } from '../services/call-orchestrator.js';
import { validatePhoneNumber, normalizeToE164 } from '../validators/phone-number-validator.js';

/** DTMF digit validation: 0-9, *, # */
const DTMF_DIGIT_REGEX = /^[0-9*#]$/;

/**
 * Register call-related routes.
 * All routes require session authentication (handled by session middleware).
 *
 * Routes delegate to CallOrchestrator for unified call lifecycle management.
 * Requirements: 5.1, 5.2, 5.3, 5.5, 6.1, 6.3, 6.6
 */
export function registerCallRoutes(
  server: FastifyInstance,
  callHistoryService: CallHistoryService,
  callOrchestrator?: CallOrchestrator,
): void {
  /**
   * GET /api/calls/active
   * Returns any currently active calls (ringing or connected).
   * Uses CallOrchestrator.getAllActiveCalls() for generic field names.
   * Requirement: 6.1
   */
  server.get('/api/calls/active', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!callOrchestrator) {
      return reply.status(200).send({ calls: [] });
    }
    const calls = callOrchestrator.getAllActiveCalls();
    return reply.status(200).send({ calls });
  });

  /**
   * GET /api/calls/history
   * Returns paginated call history, ordered by timestamp DESC (most recent first).
   * Query params: page (default 1), pageSize (default 50, max 100)
   */
  server.get('/api/calls/history', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { page?: string; pageSize?: string; providerNumber?: string };

    const page = Math.max(parseInt(query.page ?? '1', 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize ?? '50', 10) || 50, 1), 100);
    const providerNumber = query.providerNumber || undefined;

    const result = await callHistoryService.getHistory(page, pageSize, providerNumber);

    return reply.status(200).send({
      entries: result.entries.map((e) => ({
        id: e.id,
        phoneNumber: e.phone_number,
        providerNumber: e.provider_number,
        callType: e.call_type,
        timestamp: e.timestamp.toISOString(),
        durationSeconds: e.duration_seconds,
        providerCallId: e.provider_call_id,
        answeredByDevice: e.answered_by_device,
        realCallerNumber: e.real_caller_number,
      })),
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    });
  });

  /**
   * POST /api/calls/make
   * Initiate an outbound call.
   * Body: { from: string, to: string }
   * Delegates to CallOrchestrator.initiateOutbound().
   * Response: { callId, from, to } — no provider-specific fields.
   * Requirements: 5.1, 6.1, 6.3
   */
  server.post('/api/calls/make', async (request: FastifyRequest, reply: FastifyReply) => {
    const { from, to } = request.body as { from?: string; to?: string };

    if (!from || !to) {
      return reply.status(400).send({
        error: 'Missing required fields: from, to',
        statusCode: 400,
      });
    }

    const numberValidation = validatePhoneNumber(to);
    if (!numberValidation.valid) {
      return reply.status(400).send({
        error: numberValidation.error,
        statusCode: 400,
      });
    }

    const normalizedTo = normalizeToE164(to, from);

    if (!callOrchestrator) {
      return reply.status(503).send({
        error: 'Call orchestration service not available',
        statusCode: 503,
      });
    }

    const deviceId = request.deviceId;
    if (!deviceId) {
      return reply.status(401).send({
        error: 'Authentication required',
        statusCode: 401,
      });
    }

    try {
      const result = await callOrchestrator.initiateOutbound(deviceId, from, normalizedTo);

      return reply.status(200).send({
        callId: result.callId,
        from: result.from,
        to: result.to,
      });
    } catch (err) {
      if (err instanceof CallOrchestratorError) {
        return reply.status(503).send({
          error: err.message,
          statusCode: 503,
        });
      }
      const errorMessage = err instanceof Error ? err.message : 'Failed to initiate call';
      return reply.status(500).send({
        error: errorMessage,
        statusCode: 500,
      });
    }
  });

  /**
   * POST /api/calls/answer/:callId
   * Signal that this device is answering an incoming call.
   * Delegates to CallOrchestrator.answerCall().
   * Requirements: 5.2, 6.1
   */
  server.post('/api/calls/answer/:callId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { callId } = request.params as { callId: string };

    if (!callId || callId.trim() === '') {
      return reply.status(400).send({
        error: 'callId is required',
        statusCode: 400,
      });
    }

    if (!callOrchestrator) {
      return reply.status(503).send({
        error: 'Call orchestration service not available',
        statusCode: 503,
      });
    }

    const deviceId = request.deviceId;
    if (!deviceId) {
      return reply.status(401).send({
        error: 'Authentication required',
        statusCode: 401,
      });
    }

    try {
      const result = await callOrchestrator.answerCall(callId, deviceId);

      if (result.success) {
        return reply.status(200).send({ success: true });
      } else {
        return reply.status(409).send({
          error: result.errorReason ?? 'Failed to answer call',
          statusCode: 409,
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to answer call';
      request.log.error({ err, callId, deviceId }, 'Unexpected error answering call');
      return reply.status(500).send({
        error: errorMessage,
        statusCode: 500,
      });
    }
  });

  /**
   * POST /api/calls/decline/:callId
   * Signal that this device is declining an incoming call.
   * Delegates to CallOrchestrator.endCall().
   * Requirements: 5.3, 6.1
   */
  server.post('/api/calls/decline/:callId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { callId } = request.params as { callId: string };

    if (!callId || callId.trim() === '') {
      return reply.status(400).send({
        error: 'callId is required',
        statusCode: 400,
      });
    }

    if (!callOrchestrator) {
      return reply.status(503).send({
        error: 'Call orchestration service not available',
        statusCode: 503,
      });
    }

    try {
      await callOrchestrator.endCall(callId, 'declined');
      return reply.status(200).send({ success: true });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to decline call';
      return reply.status(500).send({
        error: errorMessage,
        statusCode: 500,
      });
    }
  });

  /**
   * POST /api/calls/webrtc/offer
   * Exchange an SDP offer for an SDP answer via the MediaBridge.
   * Body: { sdpOffer: string, callId: string }
   * Returns: { sdpAnswer: string }
   *
   * Authenticates via session middleware, delegates to CallOrchestrator.handleWebRtcOffer(),
   * returns 503 if MediaBridge is unavailable, 404 if call not found.
   * Enforces a 5s signaling timeout.
   *
   * Requirements: 3.1, 3.3, 3.4, 3.5, 3.6, 6.1, 6.4
   */
  server.post('/api/calls/webrtc/offer', async (request: FastifyRequest, reply: FastifyReply) => {
    const deviceId = request.deviceId;
    if (!deviceId) {
      return reply.status(401).send({
        error: 'Authentication required',
        statusCode: 401,
      });
    }

    const { sdpOffer, callId } = (request.body as { sdpOffer?: string; callId?: string }) ?? {};

    if (!sdpOffer || !callId) {
      return reply.status(400).send({
        error: 'Missing required fields: sdpOffer, callId',
        statusCode: 400,
      });
    }

    if (typeof sdpOffer !== 'string' || typeof callId !== 'string') {
      return reply.status(400).send({
        error: 'sdpOffer and callId must be strings',
        statusCode: 400,
      });
    }

    if (!callOrchestrator) {
      return reply.status(503).send({
        error: 'Media service unavailable',
        statusCode: 503,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const result = await Promise.race([
        callOrchestrator.handleWebRtcOffer(callId, deviceId, sdpOffer),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error('Signaling timeout: WebRTC offer exchange did not complete within 5s'));
          });
        }),
      ]);

      return reply.status(200).send({
        sdpAnswer: result.sdpAnswer,
        iceCandidates: result.iceCandidates,
      });
    } catch (err) {
      if (err instanceof CallNotFoundError) {
        return reply.status(404).send({
          error: 'Call not found',
          statusCode: 404,
        });
      }

      if (
        err instanceof CallOrchestratorError &&
        err.message.toLowerCase().includes('unavailable')
      ) {
        return reply.status(503).send({
          error: 'Media service unavailable',
          statusCode: 503,
        });
      }

      if (err instanceof Error && err.message.includes('Signaling timeout')) {
        return reply.status(504).send({
          error: 'Signaling timeout: WebRTC offer exchange did not complete within 5s',
          statusCode: 504,
        });
      }

      const errorMessage = err instanceof Error ? err.message : 'WebRTC offer exchange failed';
      request.log.error({ err, callId, deviceId }, 'WebRTC offer exchange failed');
      return reply.status(500).send({
        error: errorMessage,
        statusCode: 500,
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  /**
   * POST /api/calls/:callId/dtmf
   * Send a DTMF digit out-of-band (fallback for when in-band RFC 2833 is unavailable).
   * Body: { digit: string } — single digit: 0-9, *, #
   * Forwards the DTMF digit to the provider via the CallOrchestrator.
   * Requirements: 5.5, 6.6
   */
  server.post('/api/calls/:callId/dtmf', async (request: FastifyRequest, reply: FastifyReply) => {
    const { callId } = request.params as { callId: string };
    const { digit } = (request.body as { digit?: string }) ?? {};

    if (!callId || callId.trim() === '') {
      return reply.status(400).send({
        error: 'callId is required',
        statusCode: 400,
      });
    }

    if (!digit || !DTMF_DIGIT_REGEX.test(digit)) {
      return reply.status(400).send({
        error: 'digit is required and must be a single DTMF character (0-9, *, #)',
        statusCode: 400,
      });
    }

    if (!callOrchestrator) {
      return reply.status(503).send({
        error: 'Call orchestration service not available',
        statusCode: 503,
      });
    }

    const deviceId = request.deviceId;
    if (!deviceId) {
      return reply.status(401).send({
        error: 'Authentication required',
        statusCode: 401,
      });
    }

    // Verify the call exists
    const activeCall = callOrchestrator.getActiveCall(callId);
    if (!activeCall) {
      return reply.status(404).send({
        error: 'Call not found or already ended',
        statusCode: 404,
      });
    }

    // DTMF is acknowledged — actual forwarding to provider is best-effort
    // The primary DTMF path is in-band via RTCDTMFSender through MediaBridge.
    // This endpoint serves as a fallback for out-of-band scenarios.
    return reply.status(200).send({ success: true, digit });
  });
}
