import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 011: Make numbers.provider_id nullable
 *
 * When a provider is removed, its numbers are "orphaned" — deactivated, detached
 * (provider_id set to NULL), and label cleared. This preserves referential integrity
 * for messages and call_history that reference the number, while allowing the
 * provider row to be deleted.
 *
 * Changes:
 * - Drop the existing NOT NULL + FK constraint on numbers.provider_id
 * - Re-add provider_id as nullable with ON DELETE SET NULL
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Drop the existing foreign key constraint
  await sql`ALTER TABLE numbers DROP CONSTRAINT IF EXISTS numbers_provider_id_fkey`.execute(db);

  // Make provider_id nullable
  await sql`ALTER TABLE numbers ALTER COLUMN provider_id DROP NOT NULL`.execute(db);

  // Re-add FK with ON DELETE SET NULL
  await sql`
    ALTER TABLE numbers
    ADD CONSTRAINT numbers_provider_id_fkey
    FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop the SET NULL FK
  await sql`ALTER TABLE numbers DROP CONSTRAINT IF EXISTS numbers_provider_id_fkey`.execute(db);

  // Delete orphaned numbers that have NULL provider_id (can't restore NOT NULL otherwise)
  await sql`DELETE FROM numbers WHERE provider_id IS NULL`.execute(db);

  // Restore NOT NULL
  await sql`ALTER TABLE numbers ALTER COLUMN provider_id SET NOT NULL`.execute(db);

  // Re-add FK with ON DELETE RESTRICT
  await sql`
    ALTER TABLE numbers
    ADD CONSTRAINT numbers_provider_id_fkey
    FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE RESTRICT
  `.execute(db);
}
