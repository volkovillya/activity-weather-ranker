import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import type { GeocodeResult, GeoLocation } from '../../src/openmeteo/client';
import { LocationNotFoundError, UpstreamUnavailableError } from '../../src/services/errors';
import { createUpstreamLimiter } from '../../src/services/limiter';
import { createLocationService, normalizeQuery } from '../../src/services/locationService';
import { locationLookups, locations } from '../../src/db/schema';
import { openTestDb, truncateAll } from './support/database';
import { deferred, eventually, fakeGeocoder, upstreamDown } from './support/fakes';

const KRAKOW: GeoLocation = {
  id: 3094802,
  name: 'Krakow',
  country: 'Poland',
  admin1: 'Lesser Poland',
  latitude: 50.06143,
  longitude: 19.93658,
  timezone: 'Europe/Warsaw',
};
const SPRINGFIELD_MO: GeoLocation = {
  id: 4409896,
  name: 'Springfield',
  country: 'United States',
  admin1: 'Missouri',
  latitude: 37.21533,
  longitude: -93.29824,
  timezone: 'America/Chicago',
};
const SPRINGFIELD_IL: GeoLocation = { ...SPRINGFIELD_MO, id: 4250542, admin1: 'Illinois' };

const found = (location: GeoLocation): Promise<GeocodeResult> =>
  Promise.resolve({ kind: 'found', location });

const { db, pool } = openTestDb();
beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

const counts = async () => ({
  locations: (await db.select().from(locations)).length,
  lookups: (await db.select().from(locationLookups)).length,
});

describe('normalizeQuery', () => {
  it('trims, lower-cases, collapses whitespace and composes accents', () => {
    expect(normalizeQuery('  New   York ')).toBe('new york');
    expect(normalizeQuery('KRAKÓW')).toBe('kraków');
    expect(normalizeQuery('Kraków')).toBe('kraków'); // o + combining acute → ó
  });
});

describe('resolveLocation', () => {
  // L1
  it('answers a repeated search from the database without geocoding again', async () => {
    const geo = fakeGeocoder(() => found(KRAKOW));
    const service = createLocationService({
      db,
      geocode: geo.geocode,
      limiter: createUpstreamLimiter(10),
    });

    await expect(service.resolveLocation('Kraków')).resolves.toEqual(KRAKOW);
    await expect(service.resolveLocation('Kraków')).resolves.toEqual(KRAKOW);
    expect(geo.calls).toEqual(['Kraków']);
  });

  // L2
  it('treats spellings that normalise to the same text as one search', async () => {
    const geo = fakeGeocoder(() => found(KRAKOW));
    const service = createLocationService({
      db,
      geocode: geo.geocode,
      limiter: createUpstreamLimiter(10),
    });

    for (const query of ['Kraków ', 'kraków', '  KRAKÓW', 'Kraków']) {
      await expect(service.resolveLocation(query)).resolves.toMatchObject({ id: KRAKOW.id });
    }
    expect(geo.calls).toHaveLength(1);
    expect(await counts()).toEqual({ locations: 1, lookups: 1 });
  });

  // L3
  it('reports an unknown place and stores nothing', async () => {
    const geo = fakeGeocoder(() => Promise.resolve({ kind: 'not_found' }));
    const service = createLocationService({
      db,
      geocode: geo.geocode,
      limiter: createUpstreamLimiter(10),
    });

    await expect(service.resolveLocation('Zzqxqxq')).rejects.toBeInstanceOf(LocationNotFoundError);
    expect(await counts()).toEqual({ locations: 0, lookups: 0 });
  });

  // L4
  it('reports the geocoder as unavailable when it fails and the search is not stored', async () => {
    const geo = fakeGeocoder(() => Promise.reject(upstreamDown('geocoding')));
    const service = createLocationService({
      db,
      geocode: geo.geocode,
      limiter: createUpstreamLimiter(10),
    });

    const error = await service.resolveLocation('Kraków').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
    expect((error as Error).cause).toMatchObject({ name: 'UpstreamError' });
    expect(await counts()).toEqual({ locations: 0, lookups: 0 });
  });

  it('does not need the geocoder for a stored search, even while it is down', async () => {
    let up = true;
    const geo = fakeGeocoder(() =>
      up ? found(KRAKOW) : Promise.reject(upstreamDown('geocoding')),
    );
    const service = createLocationService({
      db,
      geocode: geo.geocode,
      limiter: createUpstreamLimiter(10),
    });

    await service.resolveLocation('Kraków');
    up = false;
    await expect(service.resolveLocation('kraków')).resolves.toMatchObject({ id: KRAKOW.id });
    expect(geo.calls).toHaveLength(1);
  });

  // L5
  it('survives two concurrent first searches for the same text', async () => {
    const geo = fakeGeocoder(() => found(KRAKOW));
    const service = createLocationService({
      db,
      geocode: geo.geocode,
      limiter: createUpstreamLimiter(10),
    });

    const results = await Promise.all([
      service.resolveLocation('Kraków'),
      service.resolveLocation('Kraków'),
    ]);
    expect(results.map((r) => r.id)).toEqual([KRAKOW.id, KRAKOW.id]);
    expect(await counts()).toEqual({ locations: 1, lookups: 1 });
  });

  // L6
  it('lets the persisted lookup decide when two concurrent geocodes disagree', async () => {
    const answers = [deferred<GeocodeResult>(), deferred<GeocodeResult>()];
    const geo = fakeGeocoder(() => answers[geo.calls.length - 1]!.promise);
    const service = createLocationService({
      db,
      geocode: geo.geocode,
      limiter: createUpstreamLimiter(10),
    });

    // Either request may reach the geocoder first (their lookups run on different connections),
    // so the answers go out in geocoding order, not in the order the requests were started.
    const both = [service.resolveLocation('Springfield'), service.resolveLocation('Springfield')];
    await eventually(() => geo.calls.length === 2); // both missed the lookup

    answers[0]!.resolve({ kind: 'found', location: SPRINGFIELD_MO });
    // The request that geocoded first stores Missouri and finishes; the other is still waiting.
    await expect(Promise.race(both)).resolves.toMatchObject({ id: SPRINGFIELD_MO.id });

    answers[1]!.resolve({ kind: 'found', location: SPRINGFIELD_IL });
    // The second request was told "Illinois", but the stored lookup says Missouri, and wins.
    const results = await Promise.all(both);
    expect(results.map((r) => [r.id, r.admin1])).toEqual([
      [SPRINGFIELD_MO.id, 'Missouri'],
      [SPRINGFIELD_MO.id, 'Missouri'],
    ]);

    const lookups = await db.select().from(locationLookups);
    expect(lookups).toEqual([{ queryNormalized: 'springfield', locationId: SPRINGFIELD_MO.id }]);
    await expect(service.resolveLocation('springfield')).resolves.toMatchObject({
      id: SPRINGFIELD_MO.id,
    });
    expect(geo.calls).toHaveLength(2);
  });
});

// ---------- Upstream limiter (post-review hardening, H3) ----------

describe('resolveLocation with the upstream limiter', () => {
  it('refuses a new search at once when no permit is free, and stores nothing', async () => {
    const limiter = createUpstreamLimiter(1);
    const geo = fakeGeocoder(() => found(KRAKOW));
    const service = createLocationService({ db, geocode: geo.geocode, limiter });
    const occupied = limiter.tryAcquire()!;

    await expect(service.resolveLocation('Kraków')).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
    expect(geo.calls).toHaveLength(0);
    expect(await counts()).toEqual({ locations: 0, lookups: 0 });
    occupied();
  });

  it('answers a known search without a permit', async () => {
    const limiter = createUpstreamLimiter(1);
    const geo = fakeGeocoder(() => found(KRAKOW));
    const service = createLocationService({ db, geocode: geo.geocode, limiter });
    await service.resolveLocation('Kraków');
    const occupied = limiter.tryAcquire()!;

    await expect(service.resolveLocation('kraków')).resolves.toMatchObject({ id: KRAKOW.id });
    expect(geo.calls).toHaveLength(1);
    occupied();
  });

  it.each([
    ['a match', () => found(KRAKOW)],
    ['no match', (): Promise<GeocodeResult> => Promise.resolve({ kind: 'not_found' })],
    ['an Open-Meteo failure', () => Promise.reject(upstreamDown('geocoding'))],
    ['an unexpected error', () => Promise.reject(new TypeError('a bug'))],
  ] as const)('returns the permit after %s', async (_, answer) => {
    const limiter = createUpstreamLimiter(1);
    const service = createLocationService({ db, geocode: fakeGeocoder(answer).geocode, limiter });

    await service.resolveLocation('Kraków').catch(() => undefined);

    const permit = limiter.tryAcquire();
    expect(permit).not.toBeNull();
    permit!();
  });
});
