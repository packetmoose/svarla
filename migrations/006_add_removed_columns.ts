import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Add 'removed' boolean column to conversations table (defaults to false)
  await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS removed BOOLEAN NOT NULL DEFAULT false`.execute(db);

  // Add 'removed' boolean column to messages table (defaults to false)
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS removed BOOLEAN NOT NULL DEFAULT false`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('conversations')
    .dropColumn('removed')
    .execute();

  await db.schema
    .alterTable('messages')
    .dropColumn('removed')
    .execute();
}
