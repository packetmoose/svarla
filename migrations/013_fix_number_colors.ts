import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Corrects number colors so no two ACTIVE numbers share a color.
 *
 * Background: colors were previously assigned with a per-provider counter and
 * `index % palette.length`, which caused most numbers to collapse onto the same
 * color (e.g. the first number of every provider became purple).
 *
 * New model:
 *  - `color` becomes nullable (no default). A number KEEPS its color for its
 *    lifetime, including while inactive. Colors are only reclaimed from inactive
 *    numbers by the application when the palette is exhausted by active numbers.
 *  - Active numbers each get a distinct palette color. When possible we also
 *    avoid colors currently held by inactive numbers (to reduce future reclaim
 *    churn); if the palette is exhausted by active numbers we share the
 *    least-used color. Assignment is deterministic (ordered by added_at, number).
 *  - Inactive numbers keep their existing color (it may coincide with an active
 *    color; that is fine and is resolved lazily on re-activation).
 */

// Keep in sync with NUMBER_COLOR_PALETTE in
// src/services/number-management-service.ts
const PALETTE = [
  '#6750A4', // purple
  '#006B5F', // teal
  '#B5485E', // rose
  '#526E2D', // olive
  '#7C5635', // brown
  '#00658E', // blue
  '#8B4F8A', // mauve
  '#5D5F30', // moss
  '#3F6C3A', // green
  '#9A4A2E', // terracotta
  '#455CC7', // indigo
  '#0A6E73', // deep cyan
  '#8A5A00', // amber
  '#A03E6E', // magenta
  '#4C6A8F', // slate blue
  '#7A5CA6', // violet
];

/**
 * Choose a color for an active number given the colors already taken by other
 * active numbers and those held by inactive numbers.
 *  1. First palette color free of both active and inactive holders.
 *  2. Else first palette color not used by an active number (may be on inactive).
 *  3. Else the least-used color among active numbers (tie-broken by palette order).
 * `activeCounts` is mutated by the caller after each assignment.
 */
function pickActiveColor(
  activeCounts: Map<string, number>,
  inactiveColors: Set<string>
): string {
  for (const color of PALETTE) {
    if ((activeCounts.get(color) ?? 0) === 0 && !inactiveColors.has(color)) return color;
  }
  for (const color of PALETTE) {
    if ((activeCounts.get(color) ?? 0) === 0) return color;
  }
  let best = PALETTE[0];
  let bestCount = activeCounts.get(best) ?? 0;
  for (const color of PALETTE) {
    const count = activeCounts.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

export async function up(db: Kysely<any>): Promise<void> {
  // Allow null colors and drop the old default. A number may legitimately have
  // no color once the palette is exhausted and its color is reclaimed.
  await sql`ALTER TABLE numbers ALTER COLUMN color DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE numbers ALTER COLUMN color DROP DEFAULT`.execute(db);

  // Colors currently held by inactive numbers are preserved as-is.
  const inactiveRows = await sql<{ color: string | null }>`
    SELECT color FROM numbers WHERE is_active = false AND color IS NOT NULL
  `.execute(db);
  const inactiveColors = new Set<string>(
    inactiveRows.rows.map((r) => r.color).filter((c): c is string => c != null)
  );

  // Re-assign distinct colors to active numbers deterministically.
  const rows = await sql<{ number: string }>`
    SELECT number FROM numbers WHERE is_active = true ORDER BY added_at ASC, number ASC
  `.execute(db);

  const activeCounts = new Map<string, number>();
  for (const color of PALETTE) activeCounts.set(color, 0);

  for (const row of rows.rows) {
    const color = pickActiveColor(activeCounts, inactiveColors);
    activeCounts.set(color, (activeCounts.get(color) ?? 0) + 1);
    await sql`UPDATE numbers SET color = ${color} WHERE number = ${row.number}`.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Restore NOT NULL + default. Backfill any null colors first so the
  // constraint can be applied without error.
  await sql`UPDATE numbers SET color = '#6750A4' WHERE color IS NULL`.execute(db);
  await sql`ALTER TABLE numbers ALTER COLUMN color SET DEFAULT '#6750A4'`.execute(db);
  await sql`ALTER TABLE numbers ALTER COLUMN color SET NOT NULL`.execute(db);
}
