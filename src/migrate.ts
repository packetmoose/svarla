import { Kysely, Migrator, FileMigrationProvider, PostgresDialect } from 'kysely';
import pg from 'pg';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: databaseUrl,
      }),
    }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(__dirname, '..', 'migrations'),
    }),
  });

  const command = process.argv[2];

  if (command === 'down') {
    const { error, results } = await migrator.migrateDown();
    results?.forEach((result) => {
      if (result.status === 'Success') {
        console.log(`Migration "${result.migrationName}" reverted successfully`);
      } else if (result.status === 'Error') {
        console.error(`Failed to revert migration "${result.migrationName}"`);
      }
    });
    if (error) {
      console.error('Migration rollback failed:', error);
      process.exit(1);
    }
  } else {
    // Default: migrate to latest
    const { error, results } = await migrator.migrateToLatest();
    results?.forEach((result) => {
      if (result.status === 'Success') {
        console.log(`Migration "${result.migrationName}" applied successfully`);
      } else if (result.status === 'Error') {
        console.error(`Failed to apply migration "${result.migrationName}"`);
      }
    });
    if (error) {
      console.error('Migration failed:', error);
      process.exit(1);
    }
  }

  await db.destroy();
  console.log('Done.');
}

migrate();
