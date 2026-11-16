import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbOptions } from '../../../src/db/client';
import { locations } from '../../../src/db/schema';

type StoredLocation = typeof locations.$inferSelect;

/** The development database from docker-compose.yml, unless DATABASE_URL says otherwise. */
export const ADMIN_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://ranker:ranker@localhost:5432/ranker';

/** Same server, separate database, recreated before every integration run. */
export const TEST_DATABASE_URL = (() => {
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = '/ranker_test';
  return url.toString();
})();

export function openTestDb(overrides: Partial<DbOptions> = {}) {
  return createDb({
    databaseUrl: TEST_DATABASE_URL,
    connectionTimeoutMs: 5000,
    statementTimeoutMs: 5000,
    poolMax: 10,
    ...overrides,
  });
}

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE daily_forecasts, location_lookups, locations`);
}

export const WARSAW: StoredLocation = {
  id: 3094802,
  name: 'Krakow',
  country: 'Poland',
  admin1: 'Lesser Poland',
  latitude: 50.06143,
  longitude: 19.93658,
  timezone: 'Europe/Warsaw',
};

export async function insertLocation(db: Db, location: StoredLocation = WARSAW) {
  await db.insert(locations).values(location);
  return location;
}
