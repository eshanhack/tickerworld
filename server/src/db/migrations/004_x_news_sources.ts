import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('x_news_sources')
    .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
    .addColumn('handle', 'varchar(32)', (column) => column.notNull())
    .addColumn('handle_normalized', 'varchar(32)', (column) => column.notNull().unique())
    .addColumn('name', 'varchar(100)', (column) => column.notNull())
    .addColumn('avatar_url', 'varchar(1024)')
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('since_id', 'varchar(32)')
    .addColumn('rule_pending_at', 'bigint')
    .addColumn('rule_pending_since_id', 'varchar(32)')
    .addColumn('rule_ready_at', 'bigint')
    .addColumn('last_profile_at', 'bigint')
    .addColumn('last_poll_at', 'bigint')
    .addColumn('last_success_at', 'bigint')
    .addColumn('last_post_at', 'bigint')
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .addColumn('updated_at', 'bigint', (column) => column.notNull())
    .addCheckConstraint(
      'x_news_sources_status_check',
      sql`status in ('active', 'unavailable')`,
    )
    .addCheckConstraint(
      'x_news_sources_handle_normalized_check',
      sql`handle_normalized = lower(handle_normalized)`,
    )
    .execute();

  await db.schema.createTable('x_news_worlds')
    .addColumn(
      'source_id',
      'varchar(32)',
      (column) => column.notNull().references('x_news_sources.id').onDelete('cascade'),
    )
    .addColumn('scope', 'varchar(16)', (column) => column.notNull())
    // Use 0/1 in both dialects so SQLite and Postgres expose the same runtime type.
    .addColumn('is_default', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('last_requested_at', 'bigint', (column) => column.notNull())
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .addPrimaryKeyConstraint('x_news_worlds_pk', ['source_id', 'scope'])
    .addCheckConstraint('x_news_worlds_default_check', sql`is_default in (0, 1)`)
    .addCheckConstraint('x_news_worlds_scope_check', sql`scope = upper(scope)`)
    .execute();

  await db.schema.createIndex('x_news_sources_poll_idx')
    .on('x_news_sources')
    .columns(['status', 'last_poll_at'])
    .execute();
  await db.schema.createIndex('x_news_worlds_scope_idx')
    .on('x_news_worlds')
    .columns(['scope', 'is_default'])
    .execute();
  await db.schema.createIndex('x_news_worlds_activity_idx')
    .on('x_news_worlds')
    .columns(['is_default', 'last_requested_at'])
    .execute();

  await db.schema.createTable('x_news_posts')
    .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
    .addColumn(
      'source_id',
      'varchar(32)',
      (column) => column.notNull().references('x_news_sources.id').onDelete('cascade'),
    )
    .addColumn('text', 'text', (column) => column.notNull())
    .addColumn('links_json', 'text', (column) => column.notNull())
    .addColumn('created_at', 'bigint', (column) => column.notNull())
    .addColumn('expires_at', 'bigint', (column) => column.notNull())
    .addColumn('author_name', 'varchar(100)', (column) => column.notNull())
    .addColumn('author_handle', 'varchar(32)', (column) => column.notNull())
    .addColumn('author_avatar_url', 'varchar(1024)')
    .addColumn('permalink', 'varchar(1024)', (column) => column.notNull())
    .addColumn('updated_at', 'bigint', (column) => column.notNull())
    .execute();
  await db.schema.createIndex('x_news_posts_expiry_idx')
    .on('x_news_posts')
    .column('expires_at')
    .execute();

  await db.schema.createTable('provider_health')
    .addColumn('provider', 'varchar(32)', (column) => column.primaryKey())
    .addColumn('owner_id', 'varchar(64)', (column) => column.notNull())
    .addColumn('connected', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('last_success_at', 'bigint', (column) => column.notNull())
    .addColumn('checked_at', 'bigint', (column) => column.notNull())
    .addColumn('updated_at', 'bigint', (column) => column.notNull())
    .addCheckConstraint('provider_health_connected_check', sql`connected in (0, 1)`)
    .execute();

  await db.schema.createTable('provider_leases')
    .addColumn('provider', 'varchar(32)', (column) => column.primaryKey())
    .addColumn('owner_id', 'varchar(64)', (column) => column.notNull())
    .addColumn('expires_at', 'bigint', (column) => column.notNull())
    .addColumn('updated_at', 'bigint', (column) => column.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('provider_health').ifExists().execute();
  await db.schema.dropIndex('x_news_posts_expiry_idx').ifExists().execute();
  await db.schema.dropTable('x_news_posts').ifExists().execute();
  await db.schema.dropTable('provider_leases').ifExists().execute();
  await db.schema.dropIndex('x_news_worlds_activity_idx').ifExists().execute();
  await db.schema.dropIndex('x_news_worlds_scope_idx').ifExists().execute();
  await db.schema.dropIndex('x_news_sources_poll_idx').ifExists().execute();
  await db.schema.dropTable('x_news_worlds').ifExists().execute();
  await db.schema.dropTable('x_news_sources').ifExists().execute();
}
