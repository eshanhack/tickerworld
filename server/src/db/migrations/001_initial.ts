import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('accounts')
    .addColumn('id', 'varchar(48)', (column) => column.primaryKey())
    .addColumn('wallet_address', 'varchar(64)', (column) => column.notNull().unique())
    .addColumn('actor_id', 'varchar(64)', (column) => column.notNull().unique())
    .addColumn('username', 'varchar(16)')
    .addColumn('username_normalized', 'varchar(16)', (column) => column.unique())
    .addColumn('selected_animal', 'varchar(24)', (column) => column.notNull())
    .addColumn('selected_skin', 'varchar(32)', (column) => column.notNull())
    .addColumn('last_market', 'varchar(8)', (column) => column.notNull())
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .addColumn('updated_at', 'bigint', (column) => column.notNull())
    .execute();

  await db.schema
    .createTable('auth_challenges')
    .addColumn('id', 'varchar(48)', (column) => column.primaryKey())
    .addColumn('wallet_address', 'varchar(64)', (column) => column.notNull())
    .addColumn('actor_id', 'varchar(64)', (column) => column.notNull())
    .addColumn('actor_animal', 'varchar(24)', (column) => column.notNull())
    .addColumn('nonce_hash', 'varchar(64)', (column) => column.notNull())
    .addColumn('message', 'text', (column) => column.notNull())
    .addColumn('ip_hash', 'varchar(64)', (column) => column.notNull())
    .addColumn('expires_at', 'bigint', (column) => column.notNull())
    .addColumn('consumed_at', 'bigint')
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .execute();

  await db.schema
    .createTable('auth_sessions')
    .addColumn('id', 'varchar(48)', (column) => column.primaryKey())
    .addColumn('account_id', 'varchar(48)', (column) => column.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('token_hash', 'varchar(64)', (column) => column.notNull().unique())
    .addColumn('expires_at', 'bigint', (column) => column.notNull())
    .addColumn('revoked_at', 'bigint')
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .execute();

  await db.schema
    .createTable('purchase_quotes')
    .addColumn('id', 'varchar(48)', (column) => column.primaryKey())
    .addColumn('account_id', 'varchar(48)', (column) => column.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('sku', 'varchar(40)', (column) => column.notNull())
    .addColumn('usd_cents', 'integer', (column) => column.notNull())
    .addColumn('lamports', 'varchar(32)', (column) => column.notNull())
    .addColumn('reference', 'varchar(64)', (column) => column.notNull().unique())
    .addColumn('recipient', 'varchar(64)', (column) => column.notNull())
    .addColumn('cluster', 'varchar(16)', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('requested_username', 'varchar(16)')
    .addColumn('requested_username_normalized', 'varchar(16)')
    .addColumn('expires_at', 'bigint', (column) => column.notNull())
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .execute();

  await db.schema
    .createTable('payments')
    .addColumn('id', 'varchar(48)', (column) => column.primaryKey())
    .addColumn('quote_id', 'varchar(48)', (column) => column.notNull().unique().references('purchase_quotes.id'))
    .addColumn('account_id', 'varchar(48)', (column) => column.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('signature', 'varchar(128)', (column) => column.notNull().unique())
    .addColumn('payer', 'varchar(64)', (column) => column.notNull())
    .addColumn('recipient', 'varchar(64)', (column) => column.notNull())
    .addColumn('reference', 'varchar(64)', (column) => column.notNull())
    .addColumn('lamports', 'varchar(32)', (column) => column.notNull())
    .addColumn('cluster', 'varchar(16)', (column) => column.notNull())
    .addColumn('confirmed_at', 'bigint', (column) => column.notNull())
    .execute();

  await db.schema
    .createTable('entitlements')
    .addColumn('id', 'varchar(48)', (column) => column.primaryKey())
    .addColumn('account_id', 'varchar(48)', (column) => column.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('sku', 'varchar(40)', (column) => column.notNull())
    .addColumn('source_payment_id', 'varchar(48)', (column) => column.references('payments.id'))
    .addColumn('granted_at', 'bigint', (column) => column.notNull())
    .addUniqueConstraint('entitlements_account_sku_unique', ['account_id', 'sku'])
    .execute();

  await db.schema
    .createTable('account_blocks')
    .addColumn('account_id', 'varchar(48)', (column) => column.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('blocked_actor_id', 'varchar(64)', (column) => column.notNull())
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .addPrimaryKeyConstraint('account_blocks_primary', ['account_id', 'blocked_actor_id'])
    .execute();

  await db.schema
    .createTable('moderation_reports')
    .addColumn('id', 'varchar(48)', (column) => column.primaryKey())
    .addColumn('reporter_actor_id', 'varchar(64)', (column) => column.notNull())
    .addColumn('reporter_account_id', 'varchar(48)', (column) => column.references('accounts.id').onDelete('set null'))
    .addColumn('target_actor_id', 'varchar(64)', (column) => column.notNull())
    .addColumn('market', 'varchar(8)', (column) => column.notNull())
    .addColumn('reason', 'varchar(32)', (column) => column.notNull())
    .addColumn('note', 'varchar(280)')
    .addColumn('evidence_json', 'text', (column) => column.notNull())
    .addColumn('ip_hash', 'varchar(64)', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .addColumn('resolved_at', 'bigint')
    .execute();

  await db.schema
    .createTable('moderation_actions')
    .addColumn('id', 'varchar(48)', (column) => column.primaryKey())
    .addColumn('admin_account_id', 'varchar(48)', (column) => column.notNull().references('accounts.id'))
    .addColumn('target_actor_id', 'varchar(64)')
    .addColumn('target_wallet_address', 'varchar(64)')
    .addColumn('target_ip_hash', 'varchar(64)')
    .addColumn('action', 'varchar(32)', (column) => column.notNull())
    .addColumn('reason', 'varchar(280)', (column) => column.notNull())
    .addColumn('expires_at', 'bigint')
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'moderation_actions',
    'moderation_reports',
    'account_blocks',
    'entitlements',
    'payments',
    'purchase_quotes',
    'auth_sessions',
    'auth_challenges',
    'accounts',
  ]) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
