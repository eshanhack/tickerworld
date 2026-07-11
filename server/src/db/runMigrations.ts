import { loadConfig } from '../config.js';
import { createDatabase, migrateDatabase } from './database.js';

const db = createDatabase(loadConfig());
try {
  await migrateDatabase(db);
  process.stdout.write('Tickerworld database migrations are current.\n');
} finally {
  await db.destroy();
}
