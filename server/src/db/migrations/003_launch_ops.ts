import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('provider_budgets')
    .addColumn('provider', 'varchar(32)', (column) => column.notNull())
    .addColumn('day_utc', 'varchar(10)', (column) => column.notNull())
    .addColumn('request_count', 'integer', (column) => column.notNull())
    .addColumn('updated_at', 'bigint', (column) => column.notNull())
    .addPrimaryKeyConstraint('provider_budgets_pk', ['provider', 'day_utc'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('provider_budgets').execute();
}
