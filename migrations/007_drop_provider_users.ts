import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 007: Drop provider_users table
 *
 * The provider_users table was used for Vonage Client SDK user provisioning.
 * With the new provider-generic architecture, the client connects directly
 * to the MediaBridge via WebRTC, eliminating the need for provider-specific
 * user accounts and JWT authentication.
 *
 * Requirements: 10.4, 6.7, 12.4
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_provider_users_provider').ifExists().execute();
  await db.schema.dropIndex('idx_provider_users_device').ifExists().execute();
  await db.schema.dropTable('provider_users').ifExists().execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('provider_users')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('provider_id', 'uuid', (col) => col.notNull())
    .addColumn('device_id', 'uuid', (col) => col.notNull())
    .addColumn('provider_user_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('provider_user_name', 'varchar(50)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(100)', (col) => col.notNull())
    .addColumn('push_topic', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .execute();

  await db.schema
    .createIndex('idx_provider_users_device')
    .on('provider_users')
    .column('device_id')
    .execute();

  await db.schema
    .createIndex('idx_provider_users_provider')
    .on('provider_users')
    .column('provider_id')
    .execute();
}
