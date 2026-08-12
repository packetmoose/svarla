import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import type { WebSocketBroadcaster } from '../websocket/broadcaster.js';
import type { WakeSignalPublisher } from '../notifications/wake-signal-publisher.js';
import type { DeviceRegistryManager } from './device-registry-manager.js';

/**
 * Logger interface compatible with Fastify/Pino logger.
 */
export interface NotificationServiceLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Notification type categories representing different event kinds.
 */
export type NotificationType =
  | 'incoming_call'
  | 'missed_call'
  | 'incoming_sms'
  | 'blocked_call'
  | 'new_device_login';

/**
 * Notification status representing the lifecycle state.
 */
export type NotificationStatus = 'pending' | 'read';

/**
 * Payload containing display data for a notification.
 * Fields vary depending on the notification type.
 */
export interface NotificationPayload {
  callerNumber?: string;
  senderNumber?: string;
  providerNumber?: string;
  providerLabel?: string;
  contactName?: string | null;
  messagePreview?: string;
  deviceId?: string;
  deviceLabel?: string;
  timestamp: string; // ISO 8601
}

/**
 * A notification entity as stored in the database and returned by the service.
 */
export interface NotificationEntity {
  id: string;
  type: NotificationType;
  status: NotificationStatus;
  sourceEntityId: string;
  sourceEntityType: string;
  payload: NotificationPayload;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for creating a new notification.
 */
export interface CreateNotificationInput {
  type: NotificationType;
  sourceEntityId: string;
  sourceEntityType: 'call_history' | 'messages' | 'device_registry';
  payload: NotificationPayload;
}

/**
 * Dependencies injected into NotificationService.
 */
export interface NotificationServiceDeps {
  db: Kysely<Database>;
  wsBroadcaster: WebSocketBroadcaster;
  wakeSignalPublisher: WakeSignalPublisher;
  deviceRegistryManager: DeviceRegistryManager;
  logger: NotificationServiceLogger;
}

/**
 * NotificationService manages the full notification lifecycle:
 * - Creates notifications for calls, SMS, blocked calls, and device logins
 * - Handles state transitions (pending → read, incoming_call → missed_call)
 * - Broadcasts changes to all connected devices via WebSocket
 * - Sends wake signals to offline devices via UnifiedPush
 * - Provides query methods for pending notifications
 */
export class NotificationService {
  private readonly db: Kysely<Database>;
  private readonly wsBroadcaster: WebSocketBroadcaster;
  private readonly wakeSignalPublisher: WakeSignalPublisher;
  private readonly deviceRegistryManager: DeviceRegistryManager;
  private readonly logger: NotificationServiceLogger;

  constructor(deps: NotificationServiceDeps) {
    this.db = deps.db;
    this.wsBroadcaster = deps.wsBroadcaster;
    this.wakeSignalPublisher = deps.wakeSignalPublisher;
    this.deviceRegistryManager = deps.deviceRegistryManager;
    this.logger = deps.logger;
  }

  /**
   * Create a notification entity. Returns null if duplicate (same sourceEntityId + type).
   */
  async createNotification(input: CreateNotificationInput): Promise<NotificationEntity | null> {
    // Idempotent guard: check for existing notification with same source_entity_id + type
    const existing = await this.db
      .selectFrom('notifications')
      .select('id')
      .where('source_entity_id', '=', input.sourceEntityId)
      .where('type', '=', input.type)
      .executeTakeFirst();

    if (existing) {
      this.logger.debug(
        { sourceEntityId: input.sourceEntityId, type: input.type },
        'Duplicate notification detected, skipping creation'
      );
      return null;
    }

    // INSERT into notifications table
    const row = await this.db
      .insertInto('notifications')
      .values({
        type: input.type,
        source_entity_id: input.sourceEntityId,
        source_entity_type: input.sourceEntityType,
        payload: JSON.stringify(input.payload),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Map DB row (snake_case) to NotificationEntity (camelCase)
    const entity: NotificationEntity = {
      id: row.id,
      type: row.type as NotificationType,
      status: row.status as NotificationStatus,
      sourceEntityId: row.source_entity_id,
      sourceEntityType: row.source_entity_type,
      payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as NotificationPayload,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // Broadcast notification_created event via WebSocket to all connected devices
    this.wsBroadcaster.broadcast({
      type: 'notification_created',
      data: {
        id: entity.id,
        notificationType: entity.type,
        status: entity.status,
        sourceEntityId: entity.sourceEntityId,
        sourceEntityType: entity.sourceEntityType,
        payload: entity.payload,
        createdAt: entity.createdAt.toISOString(),
      },
    });

    // Send wake signals to offline devices
    try {
      const allDevices = await this.deviceRegistryManager.getActiveDevicesWithPushInfo();
      const offlineDevices = allDevices.filter(
        (device) => !this.wsBroadcaster.isDeviceConnected(device.deviceId)
      );

      if (offlineDevices.length > 0) {
        const priority: 'high' | 'normal' = input.type === 'incoming_call' ? 'high' : 'normal';
        await this.wakeSignalPublisher.sendToAllDevices(offlineDevices, {
          id: entity.id,
          priority,
        });
        this.logger.info(
          { notificationId: entity.id, offlineDeviceCount: offlineDevices.length, priority },
          'Sent wake signals to offline devices'
        );
      }
    } catch (err) {
      this.logger.warn(
        { error: err instanceof Error ? err.message : 'Unknown error', notificationId: entity.id },
        'Failed to send wake signals to offline devices'
      );
    }

    this.logger.info(
      { notificationId: entity.id, type: entity.type, sourceEntityId: entity.sourceEntityId },
      'Notification created'
    );

    return entity;
  }

  /**
   * Mark a single notification as read by ID. No-op if already read or doesn't exist.
   */
  async markRead(notificationId: string): Promise<boolean> {
    const now = new Date();

    const result = await this.db
      .updateTable('notifications')
      .set({ status: 'read', updated_at: now })
      .where('id', '=', notificationId)
      .where('status', '=', 'pending')
      .executeTakeFirst();

    if ((result?.numUpdatedRows ?? 0n) === 0n) {
      return false;
    }

    // Fetch the updated notification to get type for broadcast
    const notification = await this.db
      .selectFrom('notifications')
      .selectAll()
      .where('id', '=', notificationId)
      .executeTakeFirst();

    if (notification) {
      this.wsBroadcaster.broadcast({
        type: 'notification_updated',
        data: {
          id: notification.id,
          notificationType: notification.type,
          status: 'read',
          updatedAt: now.toISOString(),
        },
      });
    }

    return true;
  }

  /**
   * Mark all pending notifications of given types as read.
   * If no types provided, marks all pending notifications as read.
   */
  async markAllRead(types?: NotificationType[]): Promise<number> {
    let query = this.db
      .updateTable('notifications')
      .set({
        status: 'read',
        updated_at: new Date(),
      })
      .where('status', '=', 'pending');

    if (types && types.length > 0) {
      query = query.where('type', 'in', types);
    }

    const updatedRows = await query
      .returning(['id', 'type', 'updated_at'])
      .execute();

    // Broadcast notification_updated for each affected notification
    for (const row of updatedRows) {
      this.wsBroadcaster.broadcast({
        type: 'notification_updated',
        data: {
          id: row.id,
          status: 'read',
          notificationType: row.type,
          updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
        },
      });
    }

    this.logger.info({ count: updatedRows.length, types }, 'Marked notifications as read');
    return updatedRows.length;
  }

  /**
   * Mark all SMS notifications for a conversation as read.
   * Finds all incoming_sms notifications with status pending whose source_entity_id
   * maps to messages in the given conversation, marks them as read, and broadcasts updates.
   */
  async markConversationRead(conversationNumber: string): Promise<number> {
    const updatedRows = await this.db
      .updateTable('notifications')
      .set({
        status: 'read',
        updated_at: new Date(),
      })
      .where('type', '=', 'incoming_sms')
      .where('status', '=', 'pending')
      .where('source_entity_id', 'in',
        this.db
          .selectFrom('messages')
          .select('id')
          .where('conversation_number', '=', conversationNumber)
      )
      .returningAll()
      .execute();

    // Broadcast notification_updated for each updated notification
    for (const row of updatedRows) {
      this.wsBroadcaster.broadcast({
        type: 'notification_updated',
        data: {
          id: row.id,
          notificationType: row.type,
          status: row.status,
          updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
        },
      });
    }

    if (updatedRows.length > 0) {
      this.logger.info(
        { conversationNumber, count: updatedRows.length },
        'Marked conversation SMS notifications as read'
      );
    }

    return updatedRows.length;
  }

  /**
   * Transition an incoming_call notification to missed_call (type mutation).
   * Keeps status as pending and updates updated_at.
   */
  async transitionToMissed(sourceEntityId: string): Promise<NotificationEntity | null> {
    const now = new Date();

    const row = await this.db
      .updateTable('notifications')
      .set({
        type: 'missed_call',
        updated_at: now,
      })
      .where('source_entity_id', '=', sourceEntityId)
      .where('type', '=', 'incoming_call')
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      this.logger.debug({ sourceEntityId }, 'No incoming_call notification found to transition to missed');
      return null;
    }

    const notification: NotificationEntity = {
      id: row.id,
      type: row.type as NotificationType,
      status: row.status as NotificationStatus,
      sourceEntityId: row.source_entity_id,
      sourceEntityType: row.source_entity_type,
      payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as NotificationPayload,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    this.wsBroadcaster.broadcast({
      type: 'notification_updated',
      data: {
        id: notification.id,
        notificationType: notification.type,
        status: notification.status,
        updatedAt: notification.updatedAt.toISOString(),
      },
    });

    this.logger.info({ sourceEntityId, notificationId: notification.id }, 'Transitioned notification from incoming_call to missed_call');

    return notification;
  }

  /**
   * Mark the notification for a call as read (answered or declined).
   * Matches both incoming_call and missed_call types — a declined call
   * may have already transitioned to missed_call if the provider hung up
   * or timed out before the decline was processed.
   * No-op if not found or already resolved.
   */
  async markCallResolved(sourceEntityId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('notifications')
      .set({
        status: 'read',
        updated_at: new Date(),
      })
      .where('source_entity_id', '=', sourceEntityId)
      .where('type', 'in', ['incoming_call', 'missed_call'])
      .where('status', '=', 'pending')
      .returning(['id', 'type', 'status', 'updated_at'])
      .executeTakeFirst();

    if (!result) {
      return false;
    }

    this.wsBroadcaster.broadcast({
      type: 'notification_updated',
      data: {
        id: result.id,
        status: result.status,
        notificationType: result.type,
        updatedAt: result.updated_at instanceof Date
          ? result.updated_at.toISOString()
          : result.updated_at,
      },
    });

    this.logger.info({ sourceEntityId, notificationId: result.id }, 'Call notification marked as resolved');
    return true;
  }

  /**
   * Get a single notification by ID. Returns null if not found.
   */
  async getNotificationById(notificationId: string): Promise<NotificationEntity | null> {
    const row = await this.db
      .selectFrom('notifications')
      .selectAll()
      .where('id', '=', notificationId)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      type: row.type as NotificationType,
      status: row.status as NotificationStatus,
      sourceEntityId: row.source_entity_id,
      sourceEntityType: row.source_entity_type,
      payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as NotificationPayload,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Get all pending notifications ordered by created_at ASC.
   * Only returns notifications from the last 7 days to avoid surfacing stale entries.
   * Uses the partial index idx_notifications_status_pending for efficient lookup.
   */
  async getPendingNotifications(): Promise<NotificationEntity[]> {
    const maxAge = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const rows = await this.db
      .selectFrom('notifications')
      .selectAll()
      .where('status', '=', 'pending')
      .where('created_at', '>=', maxAge)
      .orderBy('created_at', 'asc')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      type: row.type as NotificationType,
      status: row.status as NotificationStatus,
      sourceEntityId: row.source_entity_id,
      sourceEntityType: row.source_entity_type,
      payload: row.payload as NotificationPayload,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Deliver pending notifications to a reconnecting device.
   * Called on WebSocket reconnect to send all pending notifications as notification_created events.
   */
  async deliverPendingToDevice(deviceId: string): Promise<void> {
    const pending = await this.getPendingNotifications();

    this.logger.info(
      { deviceId, count: pending.length },
      `Delivering ${pending.length} pending notification(s) to reconnected device`
    );

    for (const notification of pending) {
      this.wsBroadcaster.broadcastToDevice(deviceId, {
        type: 'notification_created',
        data: {
          id: notification.id,
          notificationType: notification.type,
          status: notification.status,
          sourceEntityId: notification.sourceEntityId,
          sourceEntityType: notification.sourceEntityType,
          payload: notification.payload,
          createdAt: notification.createdAt.toISOString(),
        },
      });
    }
  }
}
