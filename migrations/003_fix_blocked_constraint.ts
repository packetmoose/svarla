import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Ensures the BLOCKED call type is in the check constraint.
 * This is a fix-up migration in case 002 was partially applied
 * (column added but constraint not updated).
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Idempotent: drop and recreate constraint with BLOCKED included
  await sql`ALTER TABLE call_history DROP CONSTRAINT IF EXISTS chk_call_type`.execute(db);
  await sql`ALTER TABLE call_history ADD CONSTRAINT chk_call_type CHECK (call_type IN ('INCOMING', 'OUTGOING', 'MISSED', 'UNANSWERED', 'DECLINED', 'BLOCKED'))`.execute(db);

  // Also ensure the column exists (idempotent)
  await sql`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS block_inbound_calls BOOLEAN NOT NULL DEFAULT false`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // No-op for down — don't remove BLOCKED support
}
