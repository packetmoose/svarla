import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 010: Drop notification_queue table
 *
 * Migrates any undelivered, non-expired entries from `notification_queue` into the
 * `notifications` table, then drops the `notification_queue` table.
 *
 * Field mapping:
 * - notification_type → type (direct mapping)
 * - device_id → not carried over (notifications are user-level)
 * - payload → payload (JSONB, preserved as-is)
 * - source_entity_id: extracted from payload->>'callId' or payload->'signal'->>'id'
 * - source_entity_type: derived from notification_type
 * - status: all migrated entries get 'pending'
 *
 * Requirements: 9.1, 9.2
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Check if there are any undelivered, non-expired entries to migrate
  const { count } = await sql<{ count: string }>`
    SELECT COUNT(*) as count
    FROM notification_queue
    WHERE delivered = false
      AND expires_at > now()
  `.execute(db).then((r) => r.rows[0]);

  if (Number(count) > 0) {
    // Migrate undelivered, non-expired entries to the notifications table
    await sql`
      INSERT INTO notifications (type, status, source_entity_id, source_entity_type, payload, created_at, updated_at)
      SELECT
        notification_type AS type,
        'pending' AS status,
        COALESCE(
          payload->>'callId',
          payload->'signal'->>'id',
          id::text
        ) AS source_entity_id,
        CASE
          WHEN notification_type IN ('incoming_call', 'missed_call', 'blocked_call') THEN 'call_history'
          WHEN notification_type = 'incoming_sms' THEN 'messages'
          WHEN notification_type = 'new_device_login' THEN 'device_registry'
          ELSE 'call_history'
        END AS source_entity_type,
        payload,
        created_at,
        now() AS updated_at
      FROM notification_queue
      WHERE delivered = false
        AND expires_at > now()
      ON CONFLICT (source_entity_id, type) DO NOTHING
    `.execute(db);
  }

  // Drop the notification_queue table and its index
  await db.schema.dropIndex('idx_notification_queue_device').ifExists().execute();
  await db.schema.dropTable('notification_queue').ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Recreate the notification_queue table
  await db.schema
    .createTable('notification_queue')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('device_id', 'uuid', (col) => col.notNull())
    .addColumn('notification_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('delivered', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();

  await db.schema
    .createIndex('idx_notification_queue_device')
    .on('notification_queue')
    .column('device_id')
    .execute();
}
