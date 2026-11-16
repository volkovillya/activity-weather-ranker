import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export interface DbOptions {
  databaseUrl: string;
  /** How long to wait for a connection to open. */
  connectionTimeoutMs: number;
  /** Postgres `statement_timeout` for every query on every pooled connection. */
  statementTimeoutMs: number;
}

/**
 * Each timeout bounds one step (opening a connection, running one statement). Neither is a
 * deadline for a whole request, which can run several statements and upstream calls.
 */
export function createDb(options: DbOptions): { db: Db; pool: Pool } {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
  });
  return { db: drizzle(pool, { schema }), pool };
}
