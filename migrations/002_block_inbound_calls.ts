import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Add column if it doesn't already exist
  await sql`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS block_inbound_calls BOOLEAN NOT NULL DEFAULT false`.execute(db);

  // Add BLOCKED to the call_type check constraint
  await sql`ALTER TABLE call_history DROP CONSTRAINT IF EXISTS chk_call_type`.execute(db);
  await sql`ALTER TABLE call_history ADD CONSTRAINT chk_call_type CHECK (call_type IN ('INCOMING', 'OUTGOING', 'MISSED', 'UNANSWERED', 'DECLINED', 'BLOCKED'))`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('numbers')
    .dropColumn('block_inbound_calls')
    .execute();

  // Restore original constraint
  await sql`ALTER TABLE call_history DROP CONSTRAINT IF EXISTS chk_call_type`.execute(db);
  await sql`ALTER TABLE call_history ADD CONSTRAINT chk_call_type CHECK (call_type IN ('INCOMING', 'OUTGOING', 'MISSED', 'UNANSWERED', 'DECLINED'))`.execute(db);
}
