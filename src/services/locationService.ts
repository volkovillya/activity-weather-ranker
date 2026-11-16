import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { locationLookups, locations } from '../db/schema';
import { UpstreamError, type OpenMeteoClient } from '../openmeteo/client';
import { LocationNotFoundError, UpstreamUnavailableError } from './errors';
import type { UpstreamLimiter } from './limiter';
import { silentLogger, type Logger } from './logger';

export type StoredLocation = typeof locations.$inferSelect;

/** "  Kraków " and "kraków" are the same search: NFC, trimmed, single spaces, lower case. */
export function normalizeQuery(query: string): string {
  return query.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface LocationServiceDeps {
  db: Db;
  geocode: OpenMeteoClient['geocode'];
  /** Shared with the forecast service: bounds upstream operations in this process. */
  limiter: UpstreamLimiter;
  logger?: Logger;
}

export function createLocationService({
  db,
  geocode,
  limiter,
  logger = silentLogger,
}: LocationServiceDeps) {
  async function findByLookup(queryNormalized: string): Promise<StoredLocation | null> {
    const [row] = await db
      .select({ location: locations })
      .from(locationLookups)
      .innerJoin(locations, eq(locationLookups.locationId, locations.id))
      .where(eq(locationLookups.queryNormalized, queryNormalized))
      .limit(1);
    return row?.location ?? null;
  }

  return {
    /**
     * A known search is answered from the database without calling the geocoder. Otherwise the
     * top geocoding match is stored with its lookup, and the stored lookup is returned.
     */
    async resolveLocation(query: string): Promise<StoredLocation> {
      const key = normalizeQuery(query);

      const known = await findByLookup(key);
      if (known) {
        logger.info({ query: key, locationId: known.id }, 'geocode.lookup_hit');
        return known;
      }

      // Only a search that is not stored needs Open-Meteo, so only it needs a permit.
      const release = limiter.tryAcquire();
      if (!release) {
        logger.warn({ query: key, reason: 'upstream_busy' }, 'geocode.skipped');
        throw new UpstreamUnavailableError('Location search is busy');
      }
      let result;
      try {
        result = await geocode(query.trim());
      } catch (error) {
        if (error instanceof UpstreamError) {
          throw new UpstreamUnavailableError('Location search is unavailable', { cause: error });
        }
        throw error;
      } finally {
        release(); // held for the upstream call only, not for the database writes below
      }
      logger.info({ query: key, result: result.kind }, 'geocode.called');
      if (result.kind === 'not_found') throw new LocationNotFoundError(query.trim());

      // Both inserts may lose to a concurrent request for the same text (DO NOTHING). The
      // geocoder can even return a different place to that request, so the persisted lookup,
      // not our own result, decides which location this text means.
      await db.insert(locations).values(result.location).onConflictDoNothing();
      await db
        .insert(locationLookups)
        .values({ queryNormalized: key, locationId: result.location.id })
        .onConflictDoNothing();

      const stored = await findByLookup(key);
      if (!stored) throw new Error(`The lookup for "${key}" is missing right after it was written`);
      return stored;
    },
  };
}

export type LocationService = ReturnType<typeof createLocationService>;
