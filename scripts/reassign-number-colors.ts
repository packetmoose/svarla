/**
 * Reassign provider-number colors to the current palette.
 *
 * Safe to run any time (idempotent-ish): it gives every ACTIVE number a
 * distinct palette color and leaves inactive numbers' colors untouched (they
 * are reclaimed lazily by the app when the palette is exhausted by active
 * numbers). Use this to migrate an existing database onto a new/updated
 * palette without editing the DB by hand.
 *
 * Usage (local dev, via tsx):
 *   DATABASE_URL=postgres://user:pass@host:5432/dbname npx tsx scripts/reassign-number-colors.ts
 *
 * Usage (inside the server container, compiled JS):
 *   docker exec -it <container> node scripts-compiled/reassign-number-colors.js --dry-run
 *   docker exec -it <container> node scripts-compiled/reassign-number-colors.js
 *   (DATABASE_URL is already set in the container's environment.)
 *
 * Flags:
 *   --dry-run    Show what would change without writing anything.
 *
 * The palette below MUST match NUMBER_COLOR_PALETTE in
 * src/services/number-management-service.ts.
 */

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

// Keep in sync with NUMBER_COLOR_PALETTE in
// src/services/number-management-service.ts
const PALETTE = [
  '#D32F2F', // red
  '#1976D2', // blue
  '#388E3C', // green
  '#F9A825', // amber
  '#7B1FA2', // purple
  '#0097A7', // cyan
  '#E64A19', // deep orange
  '#5C6BC0', // indigo
  '#689F38', // lime green
  '#C2185B', // pink
  '#00897B', // teal
  '#F57F17', // dark amber
  '#512DA8', // deep purple
  '#0288D1', // light blue
  '#AFB42B', // olive/lime
  '#AD1457', // magenta
];

/**
 * Choose a color for an active number given colors already taken by other
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

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');

  const db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: databaseUrl }),
    }),
  });

  try {
    // Colors held by inactive numbers are preserved as-is.
    const inactiveRows = await sql<{ color: string | null }>`
      SELECT color FROM numbers WHERE is_active = false AND color IS NOT NULL
    `.execute(db);
    const inactiveColors = new Set<string>(
      inactiveRows.rows.map((r) => r.color).filter((c): c is string => c != null)
    );

    // Active numbers, in a deterministic order.
    const rows = await sql<{ number: string; color: string | null }>`
      SELECT number, color FROM numbers WHERE is_active = true ORDER BY added_at ASC, number ASC
    `.execute(db);

    const activeCounts = new Map<string, number>();
    for (const color of PALETTE) activeCounts.set(color, 0);

    let changed = 0;
    for (const row of rows.rows) {
      const color = pickActiveColor(activeCounts, inactiveColors);
      activeCounts.set(color, (activeCounts.get(color) ?? 0) + 1);

      if (row.color !== color) {
        changed++;
        console.log(`${row.number}: ${row.color ?? '(none)'} -> ${color}`);
        if (!dryRun) {
          await sql`UPDATE numbers SET color = ${color} WHERE number = ${row.number}`.execute(db);
        }
      }
    }

    const total = rows.rows.length;
    if (dryRun) {
      console.log(`\nDry run: ${changed}/${total} active number(s) would change color.`);
    } else {
      console.log(`\nDone: updated ${changed}/${total} active number(s).`);
    }
    if (total > PALETTE.length) {
      console.log(
        `Note: ${total} active numbers exceed the ${PALETTE.length}-color palette, ` +
          `so some colors are shared (unavoidable beyond the palette size).`
      );
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('Failed to reassign colors:', err);
  process.exit(1);
});
