import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('notifications')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('source_entity_id', 'text', (col) => col.notNull())
    .addColumn('source_entity_type', 'text', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Partial index for efficient lookup of pending notifications
  await sql`CREATE INDEX idx_notifications_status_pending ON notifications (created_at ASC) WHERE status = 'pending'`.execute(db);

  // Index for efficient lookup by source entity
  await db.schema
    .createIndex('idx_notifications_source_entity_id')
    .on('notifications')
    .column('source_entity_id')
    .execute();

  // Unique index for idempotent creation (source_entity_id + type)
  await db.schema
    .createIndex('idx_notifications_source_entity_id_type')
    .on('notifications')
    .columns(['source_entity_id', 'type'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('notifications').ifExists().execute();
}
