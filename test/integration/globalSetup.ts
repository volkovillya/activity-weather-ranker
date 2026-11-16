import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { ADMIN_DATABASE_URL, openTestDb } from './support/database';

/** Recreates the test database and applies the real migrations, exactly as `db:migrate` would. */
export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL, connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE IF EXISTS ranker_test WITH (FORCE)');
    await admin.query('CREATE DATABASE ranker_test');
  } finally {
    await admin.end();
  }

  const { db, pool } = openTestDb();
  try {
    await migrate(db, { migrationsFolder: join(__dirname, '../../drizzle') });
  } finally {
    await pool.end();
  }
}
