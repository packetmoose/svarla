import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Adds a `color` column to the numbers table.
 * Each number gets a hex color from a predefined palette for visual identification.
 * Existing numbers are assigned colors based on their insertion order.
 */

const PALETTE = [
  '#6750A4', // purple (primary)
  '#006B5F', // teal
  '#B5485E', // rose
  '#526E2D', // olive
  '#7C5635', // brown
  '#00658E', // blue
  '#8B4F8A', // mauve
  '#5D5F30', // moss
];

export async function up(db: Kysely<any>): Promise<void> {
  // Add the color column with a default
  await sql`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS color VARCHAR(7)`.execute(db);

  // Assign colors to existing numbers based on row order
  const rows = await sql<{ number: string }>`SELECT number FROM numbers ORDER BY added_at ASC, number ASC`.execute(db);

  for (let i = 0; i < rows.rows.length; i++) {
    const color = PALETTE[i % PALETTE.length];
    await sql`UPDATE numbers SET color = ${color} WHERE number = ${rows.rows[i].number}`.execute(db);
  }

  // Set NOT NULL constraint now that all rows have values
  await sql`ALTER TABLE numbers ALTER COLUMN color SET NOT NULL`.execute(db);
  await sql`ALTER TABLE numbers ALTER COLUMN color SET DEFAULT '#6750A4'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE numbers DROP COLUMN IF EXISTS color`.execute(db);
}
