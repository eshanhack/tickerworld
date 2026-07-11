import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('purchase_quotes')
    .addColumn('claim_signature', 'varchar(128)')
    .execute();
  await db.schema.alterTable('purchase_quotes')
    .addColumn('claimed_at', 'bigint')
    .execute();

  await db.schema.createTable('username_reservations')
    .addColumn('username_normalized', 'varchar(16)', (column) => column.primaryKey())
    .addColumn('username', 'varchar(16)', (column) => column.notNull())
    .addColumn('account_id', 'varchar(48)', (column) => column.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('quote_id', 'varchar(48)', (column) => column.notNull().unique().references('purchase_quotes.id').onDelete('cascade'))
    .addColumn('expires_at', 'bigint', (column) => column.notNull())
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .execute();

  await db.schema.createTable('username_credits')
    .addColumn('id', 'varchar(48)', (column) => column.primaryKey())
    .addColumn('account_id', 'varchar(48)', (column) => column.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('source_payment_id', 'varchar(48)', (column) => column.unique().references('payments.id'))
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('consumed_username_normalized', 'varchar(16)')
    .addColumn('consumed_at', 'bigint')
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .execute();

  await db.schema.createIndex('username_reservations_expiry_idx')
    .on('username_reservations')
    .column('expires_at')
    .execute();
  await db.schema.createIndex('username_credits_account_status_idx')
    .on('username_credits')
    .columns(['account_id', 'status'])
    .execute();
  await db.schema.createIndex('auth_challenges_ip_created_idx')
    .on('auth_challenges')
    .columns(['ip_hash', 'created_at'])
    .execute();
  await db.schema.createIndex('auth_challenges_wallet_created_idx')
    .on('auth_challenges')
    .columns(['wallet_address', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('auth_challenges_wallet_created_idx').ifExists().execute();
  await db.schema.dropIndex('auth_challenges_ip_created_idx').ifExists().execute();
  await db.schema.dropIndex('username_credits_account_status_idx').ifExists().execute();
  await db.schema.dropIndex('username_reservations_expiry_idx').ifExists().execute();
  await db.schema.dropTable('username_credits').ifExists().execute();
  await db.schema.dropTable('username_reservations').ifExists().execute();
  // SQLite cannot portably drop columns. Down migrations are not used in production.
}
