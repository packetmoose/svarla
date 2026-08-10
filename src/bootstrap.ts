import { Kysely, Migrator, PostgresDialect } from 'kysely';
import pg from 'pg';
import bcrypt from 'bcrypt';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Bootstrap script that runs before the server starts:
 * 1. Runs database migrations to latest
 * 2. Sets the initial password if INITIAL_PASSWORD env var is set and no password exists yet
 */
export async function bootstrap(databaseUrl: string): Promise<void> {
  const db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: databaseUrl }),
    }),
  });

  try {
    // 1. Run migrations
    console.log('[Bootstrap] Running migrations...');

    // Look for compiled migrations first, fall back to source
    let migrationFolder = path.resolve(__dirname, '..', 'migrations-compiled');
    try {
      await fs.access(migrationFolder);
    } catch {
      migrationFolder = path.resolve(__dirname, '..', 'migrations');
    }

    const migrator = new Migrator({
      db,
      provider: {
        async getMigrations() {
          const files = await fs.readdir(migrationFolder);
          const migrations: Record<string, any> = {};

          for (const file of files.sort()) {
            if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;
            const name = file.replace(/\.(ts|js)$/, '');
            const filePath = path.join(migrationFolder, file);
            migrations[name] = await import(filePath);
          }

          return migrations;
        },
      },
    });

    const { error, results } = await migrator.migrateToLatest();

    results?.forEach((result) => {
      if (result.status === 'Success') {
        console.log(`[Bootstrap] Migration "${result.migrationName}" applied`);
      } else if (result.status === 'Error') {
        console.error(`[Bootstrap] Migration "${result.migrationName}" failed`);
      } else if (result.status === 'NotExecuted') {
        // Already applied, skip silently
      }
    });

    if (error) {
      console.error('[Bootstrap] Migration error:', error);
      throw error;
    }

    if (!results || results.filter((r) => r.status === 'Success').length === 0) {
      console.log('[Bootstrap] Database already up to date');
    }

    // 2. Set initial password if env var is provided and no password exists
    const initialPassword = process.env['INITIAL_PASSWORD'];
    const existing = await db
      .selectFrom('auth')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirst();

    if (!existing) {
      if (!initialPassword) {
        throw new Error(
          '[Bootstrap] FATAL: No password configured and INITIAL_PASSWORD environment variable is not set. ' +
          'Set INITIAL_PASSWORD to configure the initial login password.'
        );
      }
      const hash = await bcrypt.hash(initialPassword, 12);
      await db
        .insertInto('auth')
        .values({ id: 1, password_hash: hash })
        .execute();
      console.log('[Bootstrap] Initial password set');
    } else {
      console.log('[Bootstrap] Password already configured, skipping');
    }
  } finally {
    await db.destroy();
  }
}
