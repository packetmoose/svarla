import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Providers table
  await db.schema
    .createTable('providers')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('type', 'varchar(50)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(100)', (col) => col.notNull())
    .addColumn('config', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // Numbers table (replaces vonage_numbers)
  await db.schema
    .createTable('numbers')
    .addColumn('number', 'varchar(20)', (col) => col.primaryKey())
    .addColumn('provider_id', 'uuid', (col) =>
      col.notNull().references('providers.id').onDelete('restrict')
    )
    .addColumn('label', 'varchar(30)')
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('added_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('last_used_at', 'timestamptz')
    .execute();

  await db.schema
    .createIndex('idx_numbers_provider')
    .on('numbers')
    .column('provider_id')
    .execute();

  // Auth table (single-row constraint)
  await db.schema
    .createTable('auth')
    .addColumn('id', 'integer', (col) => col.primaryKey().defaultTo(1))
    .addColumn('password_hash', 'varchar(256)', (col) => col.notNull())
    .addColumn('failed_attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('locked_until', 'timestamptz')
    .execute();

  await sql`ALTER TABLE auth ADD CONSTRAINT chk_auth_single_row CHECK (id = 1)`.execute(db);

  // Device Registry table
  await db.schema
    .createTable('device_registry')
    .addColumn('device_id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('device_name', 'varchar(100)', (col) => col.notNull())
    .addColumn('push_topic_id', 'varchar(200)', (col) => col.notNull())
    .addColumn('push_endpoint_url', 'text')
    .addColumn('registered_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('session_token', 'varchar(256)', (col) => col.notNull().unique())
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .execute();

  // Provider Users table (replaces vonage_users)
  await db.schema
    .createTable('provider_users')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('provider_id', 'uuid', (col) =>
      col.notNull().references('providers.id').onDelete('restrict')
    )
    .addColumn('device_id', 'uuid', (col) =>
      col.notNull().references('device_registry.device_id')
    )
    .addColumn('provider_user_id', 'varchar(200)', (col) => col.notNull())
    .addColumn('provider_user_name', 'varchar(100)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(100)', (col) => col.notNull())
    .addColumn('push_topic', 'varchar(200)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
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

  // Conversations table
  await db.schema
    .createTable('conversations')
    .addColumn('phone_number', 'varchar(20)', (col) => col.primaryKey())
    .addColumn('last_message_preview', 'varchar(50)')
    .addColumn('last_message_timestamp', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // Messages table
  await db.schema
    .createTable('messages')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('provider_message_id', 'varchar(100)', (col) => col.unique())
    .addColumn('conversation_number', 'varchar(20)', (col) =>
      col.notNull().references('conversations.phone_number')
    )
    .addColumn('provider_number', 'varchar(20)', (col) =>
      col.references('numbers.number')
    )
    .addColumn('body', 'text', (col) => col.notNull())
    .addColumn('direction', 'varchar(10)', (col) => col.notNull())
    .addColumn('status', 'varchar(10)', (col) => col.notNull())
    .addColumn('timestamp', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('retry_count', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  await sql`ALTER TABLE messages ADD CONSTRAINT chk_direction CHECK (direction IN ('SENT', 'RECEIVED'))`.execute(db);
  await sql`ALTER TABLE messages ADD CONSTRAINT chk_status CHECK (status IN ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'QUEUED'))`.execute(db);

  await db.schema
    .createIndex('idx_messages_conversation')
    .on('messages')
    .columns(['conversation_number', 'timestamp desc'])
    .execute();

  // Call History table
  await db.schema
    .createTable('call_history')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('phone_number', 'varchar(20)', (col) => col.notNull())
    .addColumn('provider_number', 'varchar(20)', (col) =>
      col.references('numbers.number')
    )
    .addColumn('call_type', 'varchar(10)', (col) => col.notNull())
    .addColumn('timestamp', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('duration_seconds', 'integer')
    .addColumn('provider_call_id', 'varchar(100)')
    .addColumn('answered_by_device', 'uuid', (col) =>
      col.references('device_registry.device_id')
    )
    .execute();

  await sql`ALTER TABLE call_history ADD CONSTRAINT chk_call_type CHECK (call_type IN ('INCOMING', 'OUTGOING', 'MISSED', 'UNANSWERED', 'DECLINED'))`.execute(db);

  await db.schema
    .createIndex('idx_call_history_timestamp')
    .on('call_history')
    .column('timestamp desc')
    .execute();

  // Read State table
  await db.schema
    .createTable('read_state')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('item_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('item_key', 'varchar(50)', (col) => col.notNull())
    .addColumn('read_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await sql`ALTER TABLE read_state ADD CONSTRAINT chk_item_type CHECK (item_type IN ('missed_calls', 'messages'))`.execute(db);

  // Notification Queue table
  await db.schema
    .createTable('notification_queue')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('device_id', 'uuid', (col) =>
      col.notNull().references('device_registry.device_id')
    )
    .addColumn('notification_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('delivered', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();

  await db.schema
    .createIndex('idx_notification_queue_device')
    .on('notification_queue')
    .column('device_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('notification_queue').ifExists().execute();
  await db.schema.dropTable('read_state').ifExists().execute();
  await db.schema.dropTable('call_history').ifExists().execute();
  await db.schema.dropTable('messages').ifExists().execute();
  await db.schema.dropTable('conversations').ifExists().execute();
  await db.schema.dropTable('provider_users').ifExists().execute();
  await db.schema.dropTable('device_registry').ifExists().execute();
  await db.schema.dropTable('auth').ifExists().execute();
  await db.schema.dropTable('numbers').ifExists().execute();
  await db.schema.dropTable('providers').ifExists().execute();
}
