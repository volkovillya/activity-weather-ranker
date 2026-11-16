import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { createDb } from '../../src/db/client';
import { dailyForecasts } from '../../src/db/schema';
import { insertLocation, openTestDb, truncateAll, WARSAW } from './support/database';

// B1 — the timeouts are really configured, not only written down.
describe('database timeouts', () => {
  it('passes both timeouts to the pool and to every connection', async () => {
    const { pool } = openTestDb({ connectionTimeoutMs: 1234, statementTimeoutMs: 2345 });
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(1234);
      const { rows } = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
      expect(rows[0]!.statement_timeout).toBe('2345ms');
    } finally {
      await pool.end();
    }
  });

  // H4b
  it('creates the pool with the configured maximum size', async () => {
    const { pool } = openTestDb({ poolMax: 3 });
    try {
      expect(pool.options.max).toBe(3);
    } finally {
      await pool.end();
    }
  });

  it('cancels a statement that runs longer than statement_timeout', async () => {
    const { pool } = openTestDb({ statementTimeoutMs: 200 });
    try {
      const started = Date.now();
      await expect(pool.query('SELECT pg_sleep(5)')).rejects.toMatchObject({
        code: '57014', // query_canceled
      });
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await pool.end();
    }
  });

  it('gives up opening a connection after connectionTimeoutMillis', async () => {
    // A server that accepts TCP connections and never answers the Postgres handshake.
    const sockets: Socket[] = [];
    const silent: Server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as { port: number };

    const { pool } = createDb({
      databaseUrl: `postgres://ranker:ranker@127.0.0.1:${port}/ranker`,
      connectionTimeoutMs: 200,
      statementTimeoutMs: 5000,
      poolMax: 1,
    });
    try {
      const started = Date.now();
      await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await pool.end();
      sockets.forEach((s) => s.destroy());
      await new Promise((resolve) => silent.close(resolve));
    }
  });
});

describe('schema round trip', () => {
  const { db, pool } = openTestDb();
  beforeEach(() => truncateAll(db));
  afterAll(() => pool.end());

  it('keeps dates as local YYYY-MM-DD strings and timestamps to the millisecond', async () => {
    await insertLocation(db);
    const fetchedAt = new Date('2026-11-16T23:30:00.123Z');
    await db.insert(dailyForecasts).values({
      locationId: WARSAW.id,
      date: '2026-11-17',
      fetchedAt,
      marineFetched: true,
      tempMaxC: 20.3,
      waveHeightMaxM: null,
    });

    const [row] = await db
      .select()
      .from(dailyForecasts)
      .where(eq(dailyForecasts.locationId, WARSAW.id));
    expect(row!.date).toBe('2026-11-17');
    expect(row!.fetchedAt.getTime()).toBe(fetchedAt.getTime());
    expect(row!.tempMaxC).toBe(20.3);
    expect(row!.waveHeightMaxM).toBeNull();
  });
});
