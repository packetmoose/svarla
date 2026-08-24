import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 012: Remove ModemManager provider data
 *
 * Deletes all numbers associated with ModemManager providers, then deletes
 * the ModemManager provider rows themselves. This cleans up data for the
 * legacy ModemManager/D-Bus provider which has been replaced by the
 * modem-gateway provider.
 *
 * Requirements: 13.5
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Delete numbers associated with modemmanager providers
  await sql`
    DELETE FROM numbers WHERE provider_id IN (
      SELECT id FROM providers WHERE type = 'modemmanager'
    )
  `.execute(db);

  // Delete modemmanager provider rows
  await sql`DELETE FROM providers WHERE type = 'modemmanager'`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No-op: cannot restore deleted data
}
