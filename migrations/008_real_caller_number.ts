import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('call_history')
    .addColumn('real_caller_number', 'varchar(20)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('call_history')
    .dropColumn('real_caller_number')
    .execute();
}
