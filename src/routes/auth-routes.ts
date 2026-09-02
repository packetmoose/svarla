import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../services/auth-service.js';
import type { WsTicketService } from '../services/ws-ticket-service.js';
import type { WebSocketBroadcaster } from '../websocket/broadcaster.js';
import type { WakeSignalPublisher, DevicePushInfo } from '../notifications/wake-signal-publisher.js';
import { validatePassword } from '../validators/password-validator.js';

const loginSchema = z.object({
  password: z.string().min(1, 'Password is required'),
  deviceName: z.string().min(1, 'Device name is required').max(100),
  pushTopicId: z.string().min(1, 'Push topic ID is required').max(200),
});

/**
 * Register authentication routes.
 */
export function registerAuthRoutes(
  server: FastifyInstance,
  authService: AuthService,
  wsTicketService?: WsTicketService,
  wsBroadcaster?: WebSocketBroadcaster,
  wakeSignalPublisher?: WakeSignalPublisher,
  getActiveDevicesWithPushInfo?: () => Promise<DevicePushInfo[]>
): void {
  /**
   * POST /api/auth/login
   * Authenticate user, register device, and return session token.
   * Rate limited: 5 attempts per minute per IP.
   */
  server.post('/api/auth/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = loginSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.issues.map((i) => i.message),
        statusCode: 400,
      });
    }

    const { password, deviceName, pushTopicId } = parseResult.data;
    const result = await authService.login(password, deviceName, pushTopicId, {
      skipDeviceLimit: deviceName === 'Web Browser',
    });

    if (!result.success) {
      const statusCode = result.lockedUntil ? 423 : 401;
      return reply.status(statusCode).send({
        error: result.error,
        lockedUntil: result.lockedUntil?.toISOString() ?? null,
        statusCode,
      });
    }

    // Notify all other connected devices about the new login
    if (wsBroadcaster && result.deviceId) {
      wsBroadcaster.broadcastExcept(result.deviceId, {
        type: 'new_device_login',
        data: {
          deviceId: result.deviceId,
          deviceName,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Send wake signal to offline devices (those with push endpoints, excluding the new device)
    if (wakeSignalPublisher && getActiveDevicesWithPushInfo && result.deviceId) {
      getActiveDevicesWithPushInfo().then((devices) => {
        const otherDevices = devices.filter((d) => d.deviceId !== result.deviceId);
        if (otherDevices.length > 0) {
          wakeSignalPublisher.sendToAllDevices(otherDevices, {
            id: result.deviceId!,
            priority: 'normal',
          }, 'new_device_login');
        }
      }).catch((err) => {
        server.log.error(err, 'Failed to send new_device_login wake signal');
      });
    }

    return reply.status(200).send({
      sessionToken: result.sessionToken,
      deviceId: result.deviceId,
      pushTopicId: result.pushTopicId,
    });
  });

  /**
   * POST /api/auth/logout
   * Invalidate session token and deregister device.
   */
  server.post('/api/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: 'Missing or invalid authorization header',
        statusCode: 401,
      });
    }

    const sessionToken = authHeader.slice(7);
    const success = await authService.logout(sessionToken);

    if (!success) {
      return reply.status(401).send({
        error: 'Invalid or already expired session',
        statusCode: 401,
      });
    }

    return reply.status(200).send({
      message: 'Logged out successfully',
    });
  });

  /**
   * POST /api/auth/change-password
   * Change the user's password. Requires valid session (enforced by session middleware).
   */
  const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(1, 'New password is required'),
    confirmPassword: z.string().min(1, 'Password confirmation is required'),
  });

  server.post('/api/auth/change-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = changePasswordSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.issues.map((i) => i.message),
        statusCode: 400,
      });
    }

    const { currentPassword, newPassword, confirmPassword } = parseResult.data;

    // Verify current password against stored hash
    const auth = await authService.getAuth();
    if (!auth) {
      return reply.status(500).send({
        error: 'Authentication not configured',
        statusCode: 500,
      });
    }

    const bcrypt = await import('bcrypt');
    const currentPasswordValid = await bcrypt.compare(currentPassword, auth.passwordHash);
    if (!currentPasswordValid) {
      return reply.status(401).send({
        error: 'Current password is incorrect',
        statusCode: 401,
      });
    }

    // Validate new password against rules
    const validationResult = validatePassword(newPassword);
    if (!validationResult.valid) {
      return reply.status(400).send({
        error: validationResult.error,
        statusCode: 400,
      });
    }

    // Validate confirmation matches
    if (newPassword !== confirmPassword) {
      return reply.status(400).send({
        error: 'Passwords do not match',
        statusCode: 400,
      });
    }

    // Hash the new password and update
    const newHash = await authService.hashPassword(newPassword);
    await authService.updatePasswordHash(newHash);

    return reply.status(200).send({
      message: 'Password changed successfully',
    });
  });

  /**
   * POST /api/auth/ws-ticket
   * Issue a short-lived, single-use ticket for WebSocket authentication.
   * Prevents the long-lived session token from being exposed in query parameters.
   * Requires valid session (enforced by session middleware).
   */
  server.post('/api/auth/ws-ticket', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.sessionToken || !request.deviceId) {
      return reply.status(401).send({
        error: 'Authentication required',
        statusCode: 401,
      });
    }

    if (!wsTicketService) {
      return reply.status(503).send({
        error: 'WebSocket ticket service unavailable',
        statusCode: 503,
      });
    }

    try {
      const ticket = wsTicketService.issueTicket(request.sessionToken, request.deviceId);
      return reply.status(200).send({
        ticket,
        expiresIn: 30, // seconds
      });
    } catch (err) {
      return reply.status(429).send({
        error: 'Too many pending tickets',
        statusCode: 429,
      });
    }
  });
}
