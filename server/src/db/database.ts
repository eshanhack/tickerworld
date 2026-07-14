import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  Kysely,
  PostgresDialect,
  SqliteDialect,
} from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import pg from 'pg';
import type { ServerConfig } from '../config.js';
import type { DatabaseSchema } from './types.js';
import * as initialMigration from './migrations/001_initial.js';
import * as identitySafetyMigration from './migrations/002_identity_safety.js';
import * as launchOpsMigration from './migrations/003_launch_ops.js';
import * as xNewsSourcesMigration from './migrations/004_x_news_sources.js';

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      '001_initial': initialMigration as Migration,
      '002_identity_safety': identitySafetyMigration as Migration,
      '003_launch_ops': launchOpsMigration as Migration,
      '004_x_news_sources': xNewsSourcesMigration as Migration,
    };
  }
}

export function createDatabase(config: ServerConfig): Kysely<DatabaseSchema> {
  if (config.databaseUrl) {
    // Millisecond timestamps remain far below Number.MAX_SAFE_INTEGER.
    pg.types.setTypeParser(20, (value) => Number(value));
    return new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString: config.databaseUrl,
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
          ssl: config.databaseSsl === 'disable' ? false : { rejectUnauthorized: true },
        }),
      }),
    });
  }

  const file = config.sqlitePath === ':memory:' ? ':memory:' : resolve(config.sqlitePath);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  if (file !== ':memory:') sqlite.pragma('journal_mode = WAL');
  return new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: sqlite }) });
}

export async function migrateDatabase(db: Kysely<DatabaseSchema>): Promise<void> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
  const result = await migrator.migrateToLatest();
  if (result.error) throw result.error;
  const failed = result.results?.find((entry) => entry.status === 'Error');
  if (failed) throw new Error(`Migration ${failed.migrationName} failed`);
}

export async function databaseIsReady(db: Kysely<DatabaseSchema>): Promise<boolean> {
  try {
    await db.selectFrom('accounts').select('id').limit(1).execute();
    return true;
  } catch {
    return false;
  }
}
