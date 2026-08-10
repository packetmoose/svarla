import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { NotificationService, NotificationType } from '../services/notification-service.js';

const VALID_NOTIFICATION_TYPES: NotificationType[] = [
  'incoming_call',
  'missed_call',
  'incoming_sms',
  'blocked_call',
  'new_device_login',
];

const notificationIdParamSchema = z.object({
  id: z.string().min(1),
});

const readAllQuerySchema = z.object({
  type: z.string().optional(),
});

/**
 * Register notification API routes.
 * All routes require session authentication (handled by session middleware).
 *
 * Requirements covered: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */
export function registerNotificationRoutes(
  server: FastifyInstance,
  notificationService: NotificationService
): void {
  /**
   * GET /api/notifications
   * Returns all pending notifications ordered by created_at ascending.
   */
  server.get('/api/notifications', async (_request: FastifyRequest, reply: FastifyReply) => {
    const notifications = await notificationService.getPendingNotifications();
    return reply.status(200).send(notifications);
  });

  /**
   * GET /api/notifications/:id
   * Returns a single notification by ID. Returns 404 if not found.
   */
  server.get('/api/notifications/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const paramResult = notificationIdParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({ error: 'Invalid notification ID', statusCode: 400 });
    }

    const { id } = paramResult.data;
    const notification = await notificationService.getNotificationById(id);

    if (!notification) {
      return reply.status(404).send({ error: 'Notification not found', statusCode: 404 });
    }

    return reply.status(200).send(notification);
  });

  /**
   * POST /api/notifications/:id/read
   * Marks a single notification as read. Returns 404 if notification does not exist.
   */
  server.post('/api/notifications/:id/read', async (request: FastifyRequest, reply: FastifyReply) => {
    const paramResult = notificationIdParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({ error: 'Invalid notification ID', statusCode: 400 });
    }

    const { id } = paramResult.data;
    const updated = await notificationService.markRead(id);

    if (!updated) {
      return reply.status(404).send({ error: 'Notification not found', statusCode: 404 });
    }

    return reply.status(200).send({ message: 'Notification marked as read' });
  });

  /**
   * POST /api/notifications/read-all
   * Marks all pending notifications as read, optionally filtered by type.
   * Returns 400 if the type query parameter is not a valid NotificationType.
   */
  server.post('/api/notifications/read-all', async (request: FastifyRequest, reply: FastifyReply) => {
    const queryResult = readAllQuerySchema.safeParse(request.query);
    const type = queryResult.success ? queryResult.data.type : undefined;

    if (type !== undefined) {
      if (!VALID_NOTIFICATION_TYPES.includes(type as NotificationType)) {
        return reply.status(400).send({
          error: `Invalid notification type: "${type}". Valid types are: ${VALID_NOTIFICATION_TYPES.join(', ')}`,
          statusCode: 400,
        });
      }
    }

    const types = type ? [type as NotificationType] : undefined;
    await notificationService.markAllRead(types);

    return reply.status(200).send({ message: 'Notifications marked as read' });
  });
}
