import { Kysely, PostgresDialect } from 'kysely';
import type { Generated } from 'kysely';
import pg from 'pg';
import type { AppConfig } from './config.js';

/**
 * Database table type definitions for Kysely.
 * Uses `Generated<T>` for columns that have database-level defaults.
 */

export interface ProvidersTable {
  id: Generated<string>;
  type: string;
  display_name: string;
  config: unknown;  // JSONB
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AuthTable {
  id: Generated<number>;
  password_hash: string;
  failed_attempts: Generated<number>;
  locked_until: Date | null;
}

export interface DeviceRegistryTable {
  device_id: Generated<string>;
  device_name: string;
  push_topic_id: string;
  push_endpoint_url: string | null;
  registered_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  session_token: string;
  is_active: Generated<boolean>;
}

export interface NumbersTable {
  number: string;
  provider_id: string | null;
  label: string | null;
  color: string | null;
  is_active: Generated<boolean>;
  added_at: Generated<Date>;
  last_used_at: Date | null;
  block_inbound_calls: Generated<boolean>;
}

export interface CallHistoryTable {
  id: Generated<string>;
  phone_number: string;
  provider_number: string | null;
  call_type: 'INCOMING' | 'OUTGOING' | 'MISSED' | 'UNANSWERED' | 'DECLINED' | 'BLOCKED';
  timestamp: Generated<Date>;
  duration_seconds: number | null;
  provider_call_id: string | null;
  answered_by_device: string | null;
  real_caller_number: string | null;
}

export interface ConversationsTable {
  phone_number: string;
  provider_number: Generated<string>;
  last_message_preview: string | null;
  last_message_timestamp: Date | null;
  removed: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface MessagesTable {
  id: Generated<string>;
  provider_message_id: string | null;
  conversation_number: string;
  provider_number: string | null;
  body: string;
  direction: 'SENT' | 'RECEIVED';
  status: 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'QUEUED';
  timestamp: Generated<Date>;
  retry_count: Generated<number>;
  removed: Generated<boolean>;
}

export interface ReadStateTable {
  id: Generated<string>;
  item_type: 'missed_calls' | 'messages';
  item_key: string;
  read_at: Generated<Date>;
}

export interface SettingsTable {
  key: string;
  value: string | null;
  updated_at: Generated<Date>;
}

export interface NotificationsTable {
  id: Generated<string>;
  type: string;
  status: Generated<string>;
  source_entity_id: string;
  source_entity_type: string;
  payload: Generated<unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  providers: ProvidersTable;
  numbers: NumbersTable;
  auth: AuthTable;
  device_registry: DeviceRegistryTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  call_history: CallHistoryTable;
  read_state: ReadStateTable;
  notifications: NotificationsTable;
  settings: SettingsTable;
}

/**
 * Create a Kysely database instance from the app config.
 */
export function createDatabase(config: AppConfig): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: config.databaseUrl,
      }),
    }),
  });
}
