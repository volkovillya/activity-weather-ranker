import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { asc, eq, sql } from 'drizzle-orm';
import { dailyForecasts } from '../../src/db/schema';
import { rankActivities } from '../../src/domain/rank';
import type { DailyWeather } from '../../src/domain/types';
import type { MarineDay, WeatherDay } from '../../src/openmeteo/client';
import { UpstreamUnavailableError } from '../../src/services/errors';
import { createForecastService } from '../../src/services/forecastService';
import type { StoredLocation } from '../../src/services/locationService';
import { insertLocation, openTestDb, truncateAll, WARSAW } from './support/database';
import {
  deferred,
  eventually,
  fakeClock,
  fakeForecastClient,
  inlandMarine,
  marineWeek,
  recordingLogger,
  upstreamDown,
  weatherWeek,
} from './support/fakes';

const BIARRITZ: StoredLocation = {
  id: 3032797,
  name: 'Biarritz',
  country: 'France',
  admin1: 'New Aquitaine',
  latitude: 43.48055,
  longitude: -1.55684,
  timezone: 'Europe/Paris',
};

// 11:00 in Warsaw (UTC+1 in November): the week is 16–22 November.
const T0 = '2026-11-16T10:00:00Z';
const T0_MS = new Date(T0).getTime();
const WEEK_16 = [
  '2026-11-16',
  '2026-11-17',
  '2026-11-18',
  '2026-11-19',
  '2026-11-20',
  '2026-11-21',
  '2026-11-22',
];
const WEEK_17 = [...WEEK_16.slice(1), '2026-11-23'];

const { db, pool } = openTestDb();
beforeEach(async () => {
  await truncateAll(db);
  await insertLocation(db, WARSAW);
});
afterAll(() => pool.end());

type Fake = ReturnType<typeof fakeForecastClient>;
type Time = ReturnType<typeof fakeClock>;

function setup(options: { ttl?: number; retry?: number; time?: Time; fake?: Fake } = {}) {
  const time = options.time ?? fakeClock(T0);
  const fake = options.fake ?? fakeForecastClient();
  const log = recordingLogger();
  const service = createForecastService({
    db,
    client: fake.client,
    clock: time.clock,
    forecastTtlSeconds: options.ttl ?? 3600,
    marineRetrySeconds: options.retry ?? 300,
    logger: log.logger,
  });
  return { service, fake, time, log };
}

const failing = (endpoint: 'forecast' | 'marine') => () => Promise.reject(upstreamDown(endpoint));
const temps = (days: DailyWeather[]) => days.map((d) => d.tempMaxC);
const dates = (days: DailyWeather[]) => days.map((d) => d.date);
const surfingReason = (days: DailyWeather[]) => rankActivities(days)[1]!.unavailableReason;

const storedRows = (locationId = WARSAW.id) =>
  db
    .select()
    .from(dailyForecasts)
    .where(eq(dailyForecasts.locationId, locationId))
    .orderBy(asc(dailyForecasts.date));

/** Writes rows directly, to set up a stored state the service did not produce itself. */
async function storeRows(rowDates: string[], fetchedAtMs: number, marker = 0) {
  await db.insert(dailyForecasts).values(
    weatherWeek(rowDates, marker).map((day) => ({
      ...day,
      locationId: WARSAW.id,
      fetchedAt: new Date(fetchedAtMs),
      marineFetched: true,
      waveHeightMaxM: 1.5,
      swellPeriodMaxS: 10,
    })),
  );
}

describe('freshness', () => {
  // F1
  it('serves a stored week within the TTL without calling Open-Meteo', async () => {
    const { service, fake, time, log } = setup();
    await service.getWeek(WARSAW);
    time.advanceSeconds(10);
    const week = await service.getWeek(WARSAW);

    expect(fake.calls.weather).toHaveLength(1);
    expect(fake.calls.marine).toHaveLength(1);
    expect(log.count('forecast.cache_hit')).toBe(1);
    expect(dates(week.days)).toEqual(WEEK_16);
    expect(week).toMatchObject({ stale: false, fetchedAt: new Date(T0) });
  });

  // F2
  it('refetches once the TTL has passed, and replaces the stored values', async () => {
    const { service, fake, time } = setup();
    await service.getWeek(WARSAW);

    time.advanceSeconds(3599);
    await service.getWeek(WARSAW);
    expect(fake.calls.weather).toHaveLength(1);

    time.advanceSeconds(1); // exactly the TTL: no longer fresh
    fake.weather = (d) => Promise.resolve(weatherWeek(d, 2));
    const week = await service.getWeek(WARSAW);

    expect(fake.calls.weather).toHaveLength(2);
    expect(temps(week.days)).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(week.fetchedAt).toEqual(new Date(T0_MS + 3600_000));
    expect(temps(await storedRows())).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });

  // F3
  it('refetches after local midnight even within the TTL, because the week has moved', async () => {
    const { service, fake, time } = setup({ time: fakeClock('2026-11-16T22:50:00Z') }); // 23:50
    expect(dates((await service.getWeek(WARSAW)).days)).toEqual(WEEK_16);

    time.set('2026-11-16T23:10:00Z'); // 00:10 on the 17th, twenty minutes later
    const week = await service.getWeek(WARSAW);

    expect(fake.calls.weather).toHaveLength(2);
    expect(fake.calls.weather[1]!.dates).toEqual(WEEK_17);
    expect(dates(week.days)).toEqual(WEEK_17);
  });

  // F4
  it('decides completeness by date, not by the number of rows', async () => {
    // Seven fresh rows, but the 22nd is missing and the 23rd is outside this week.
    await storeRows([...WEEK_16.slice(0, 6), '2026-11-23'], T0_MS);
    const { service, fake } = setup();
    const week = await service.getWeek(WARSAW);

    expect(fake.calls.weather).toHaveLength(1);
    expect(dates(week.days)).toEqual(WEEK_16);
  });
});

describe('weather failures', () => {
  // F5
  it('serves the stored week as stale when the TTL has passed and the refresh fails', async () => {
    const { service, fake, time } = setup();
    await service.getWeek(WARSAW);
    time.advanceSeconds(3700);
    fake.weather = failing('forecast');

    const week = await service.getWeek(WARSAW);
    expect(fake.calls.weather).toHaveLength(2);
    expect(week.stale).toBe(true);
    expect(week.fetchedAt).toEqual(new Date(T0));
    expect(temps(week.days)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  // F6
  it('never serves a partial week: six stored days and a failed refresh is an error', async () => {
    await storeRows(WEEK_16.slice(0, 6), T0_MS - 7200_000);
    const { service, fake } = setup();
    fake.weather = failing('forecast');

    await expect(service.getWeek(WARSAW)).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  // F7
  it('fails when nothing is stored and the refresh fails', async () => {
    const { service, fake } = setup();
    fake.weather = failing('forecast');

    await expect(service.getWeek(WARSAW)).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(await storedRows()).toHaveLength(0);
  });

  // F14
  it('tries again on the next request after a failed refresh', async () => {
    const { service, fake } = setup();
    fake.weather = failing('forecast');
    await expect(service.getWeek(WARSAW)).rejects.toBeInstanceOf(UpstreamUnavailableError);

    fake.weather = (d) => Promise.resolve(weatherWeek(d, 1));
    await expect(service.getWeek(WARSAW)).resolves.toMatchObject({ stale: false });
    expect(fake.calls.weather).toHaveLength(2);
  });

  // F15
  it('returns nothing from a payload that failed to persist, and retries next time', async () => {
    await db.execute(
      sql`ALTER TABLE daily_forecasts ADD CONSTRAINT test_temp_limit CHECK (temp_max_c < 1000)`,
    );
    const { service, fake } = setup();
    try {
      fake.weather = (d) => Promise.resolve(weatherWeek(d, 5000)); // violates the constraint
      const error = await service.getWeek(WARSAW).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UpstreamUnavailableError); // a database fault, not stale weather
      expect(await storedRows()).toHaveLength(0);
    } finally {
      await db.execute(sql`ALTER TABLE daily_forecasts DROP CONSTRAINT IF EXISTS test_temp_limit`);
    }

    fake.weather = (d) => Promise.resolve(weatherWeek(d, 1));
    const week = await service.getWeek(WARSAW);
    expect(fake.calls.weather).toHaveLength(2);
    expect(temps(week.days)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

describe('marine data', () => {
  // F8
  it('stores the weather and flags the week when only the marine request fails', async () => {
    const { service, fake } = setup();
    fake.marine = failing('marine');

    const week = await service.getWeek(WARSAW);
    expect(week.stale).toBe(false);
    expect(temps(week.days)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(surfingReason(week.days)).toBe('MARINE_TEMPORARILY_UNAVAILABLE');
    expect(rankActivities(week.days)[0]!.available).toBe(true); // skiing is unaffected

    const rows = await storedRows();
    expect(rows.every((r) => !r.marineFetched && r.waveHeightMaxM === null)).toBe(true);
  });

  // F9
  it('retries a failed marine request after the retry window, not before', async () => {
    const { service, fake, time } = setup({ ttl: 3600, retry: 300 });
    fake.marine = failing('marine');
    await service.getWeek(WARSAW);

    time.advanceSeconds(299);
    await service.getWeek(WARSAW);
    expect(fake.calls.marine).toHaveLength(1);

    time.advanceSeconds(2); // 301 s
    fake.marine = (d) => Promise.resolve(marineWeek(d, 1.5));
    const week = await service.getWeek(WARSAW);
    expect(fake.calls.weather).toHaveLength(2);
    expect(fake.calls.marine).toHaveLength(2);
    expect(surfingReason(week.days)).toBeNull();
  });

  it('never keeps a marine-failed week longer than the TTL when the TTL is shorter', async () => {
    const { service, fake, time } = setup({ ttl: 60, retry: 300 });
    fake.marine = failing('marine');
    await service.getWeek(WARSAW);

    time.advanceSeconds(61);
    await service.getWeek(WARSAW);
    expect(fake.calls.weather).toHaveLength(2);
  });

  it('refetches on every request with a TTL of 0', async () => {
    const { service, fake } = setup({ ttl: 0 });
    await service.getWeek(WARSAW);
    await service.getWeek(WARSAW);
    await service.getWeek(WARSAW);
    expect(fake.calls.weather).toHaveLength(3);
  });

  // F10
  it('tells an inland location apart from a failed marine request', async () => {
    await insertLocation(db, BIARRITZ);
    const { service, fake, time } = setup({ ttl: 3600, retry: 300 });
    fake.marine = (d, point) =>
      point.latitude === WARSAW.latitude
        ? Promise.resolve(inlandMarine(d))
        : Promise.reject(upstreamDown('marine'));

    const inland = await service.getWeek(WARSAW);
    const failed = await service.getWeek(BIARRITZ);
    expect(surfingReason(inland.days)).toBe('NO_MARINE_DATA');
    expect(surfingReason(failed.days)).toBe('MARINE_TEMPORARILY_UNAVAILABLE');
    expect((await storedRows(WARSAW.id)).every((r) => r.marineFetched)).toBe(true);
    expect((await storedRows(BIARRITZ.id)).every((r) => !r.marineFetched)).toBe(true);

    time.advanceSeconds(301);
    await service.getWeek(WARSAW);
    await service.getWeek(BIARRITZ);
    const marineCallsFor = (lat: number) =>
      fake.calls.marine.filter((c) => c.point.latitude === lat).length;
    expect(marineCallsFor(WARSAW.latitude)).toBe(1); // inland is complete data: fresh for the TTL
    expect(marineCallsFor(BIARRITZ.latitude)).toBe(2); // failed: retried after the window
  });

  // F17
  it('does not report weather as stale because of a marine retry', async () => {
    const { service, fake, time } = setup({ ttl: 3600, retry: 300 });
    fake.marine = failing('marine');
    await service.getWeek(WARSAW);

    time.advanceSeconds(400); // marine retry due, weather still within the TTL
    fake.weather = failing('forecast');
    const retried = await service.getWeek(WARSAW);
    expect(fake.calls.weather).toHaveLength(2);
    expect(retried.stale).toBe(false);
    expect(retried.fetchedAt).toEqual(new Date(T0));
    expect(surfingReason(retried.days)).toBe('MARINE_TEMPORARILY_UNAVAILABLE');

    time.advanceSeconds(3300); // 3 700 s: now the weather itself is past the TTL
    expect((await service.getWeek(WARSAW)).stale).toBe(true);
  });
});

describe('stale with very small TTLs', () => {
  // F18
  it('is false after a successful refresh and true after a failed one, with a TTL of 0', async () => {
    const { service, fake } = setup({ ttl: 0 });
    expect((await service.getWeek(WARSAW)).stale).toBe(false);

    fake.weather = failing('forecast');
    expect((await service.getWeek(WARSAW)).stale).toBe(true);
  });

  it('is false when the refresh succeeds even if it took longer than the TTL', async () => {
    const { service, fake, time } = setup({ ttl: 1 });
    const answer = deferred<WeatherDay[]>();
    fake.weather = () => answer.promise;

    const pending = service.getWeek(WARSAW);
    await eventually(() => fake.calls.weather.length === 1);
    time.advanceSeconds(2);
    answer.resolve(weatherWeek(WEEK_16, 1));

    const week = await pending;
    expect(week.stale).toBe(false);
    expect(week.fetchedAt).toEqual(new Date(T0));
  });
});

describe('concurrency', () => {
  // F11
  it('orders refreshes by request time: a slow marine call cannot let older weather win', async () => {
    const time = fakeClock(T0);
    const a = setup({ time });
    const b = setup({ time }); // a second instance on the same database
    const slowMarine = deferred<MarineDay[]>();
    a.fake.marine = () => slowMarine.promise; // A's weather answers at once

    const pendingA = a.service.getWeek(WARSAW); // requested at t0
    await eventually(() => a.fake.calls.marine.length === 1);

    time.advanceSeconds(1); // B is requested at t0 + 1 s and completes
    b.fake.weather = (d) => Promise.resolve(weatherWeek(d, 2));
    b.fake.marine = (d) => Promise.resolve(marineWeek(d, 2.5));
    await b.service.getWeek(WARSAW);

    time.advanceSeconds(2); // A's marine finally fails at t0 + 3 s and A writes
    slowMarine.reject(upstreamDown('marine'));
    const weekA = await pendingA;

    expect(temps(weekA.days)).toEqual([2, 2, 2, 2, 2, 2, 2]); // A receives B's newer rows
    expect(weekA.fetchedAt).toEqual(new Date(T0_MS + 1000));
    const rows = await storedRows();
    expect(rows.every((r) => r.tempMaxC === 2 && r.marineFetched && r.waveHeightMaxM === 2.5)).toBe(
      true,
    );

    // A's failed marine call did not invalidate B's marine data, for A's caller either...
    expect(surfingReason(weekA.days)).toBeNull();
    // ...and the week is not treated as "marine failed" later: past the retry window, within the
    // TTL, nothing is refetched.
    time.advanceSeconds(301);
    await a.service.getWeek(WARSAW);
    expect(a.fake.calls.marine).toHaveLength(1);
    expect(b.fake.calls.marine).toHaveLength(1);
  });

  it('lets a refresh requested later win even when its marine call failed (documented trade-off)', async () => {
    // The mirror image of F11: B is requested first and persists first; A is requested one
    // second later, its marine call fails, and it persists last. A's weather is newer, so A's
    // rows win, and weather and marine are replaced as one unit: B's good wave data is lost
    // until the marine retry window passes. Pinned here so the behaviour cannot change unnoticed.
    const time = fakeClock(T0);
    const b = setup({ time });
    const a = setup({ time });
    const weatherB = deferred<WeatherDay[]>();
    const marineB = deferred<MarineDay[]>();
    b.fake.weather = () => weatherB.promise;
    b.fake.marine = () => marineB.promise;
    const marineA = deferred<MarineDay[]>();
    a.fake.marine = () => marineA.promise;

    const pendingB = b.service.getWeek(WARSAW); // requested at t0
    await eventually(() => b.fake.calls.marine.length === 1);
    time.advanceSeconds(1);
    const pendingA = a.service.getWeek(WARSAW); // requested at t0 + 1 s
    await eventually(() => a.fake.calls.marine.length === 1);

    weatherB.resolve(weatherWeek(WEEK_16, 2));
    marineB.resolve(marineWeek(WEEK_16, 2.5));
    expect(surfingReason((await pendingB).days)).toBeNull(); // B persisted first, complete

    marineA.reject(upstreamDown('marine'));
    const weekA = await pendingA;
    expect(temps(weekA.days)).toEqual([1, 1, 1, 1, 1, 1, 1]); // A's newer weather
    expect(surfingReason(weekA.days)).toBe('MARINE_TEMPORARILY_UNAVAILABLE');
    expect((await storedRows()).every((r) => !r.marineFetched && r.waveHeightMaxM === null)).toBe(
      true,
    );

    // It heals: once the retry window has passed, the next request fetches marine again.
    time.advanceSeconds(301);
    a.fake.marine = (d) => Promise.resolve(marineWeek(d, 2.5));
    const healed = await a.service.getWeek(WARSAW);
    expect(a.fake.calls.marine).toHaveLength(2);
    expect(surfingReason(healed.days)).toBeNull();
  });

  // F12
  it('serves what another instance persisted when its own refresh fails', async () => {
    const time = fakeClock(T0);
    const a = setup({ time });
    const b = setup({ time });
    const weatherA = deferred<WeatherDay[]>();
    a.fake.weather = () => weatherA.promise;

    const pendingA = a.service.getWeek(WARSAW);
    await eventually(() => a.fake.calls.weather.length === 1);

    time.advanceSeconds(1);
    b.fake.weather = (d) => Promise.resolve(weatherWeek(d, 2));
    await b.service.getWeek(WARSAW);

    weatherA.reject(upstreamDown('forecast'));
    const weekA = await pendingA;
    expect(weekA.stale).toBe(false); // the week B stored is within the TTL
    expect(temps(weekA.days)).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });

  // F13
  it('shares one refresh between concurrent requests for the same location and week', async () => {
    const { service, fake, log } = setup();
    const weather = deferred<WeatherDay[]>();
    const marine = deferred<MarineDay[]>();
    fake.weather = () => weather.promise;
    fake.marine = () => marine.promise;

    const requests = Array.from({ length: 10 }, () => service.getWeek(WARSAW));
    await eventually(() => log.count('forecast.cache_miss') === 10); // all ten missed the cache

    expect(fake.calls.weather).toHaveLength(1); // before anything is answered
    expect(fake.calls.marine).toHaveLength(1);

    weather.resolve(weatherWeek(WEEK_16, 1));
    marine.resolve(marineWeek(WEEK_16, 1.5));
    const weeks = await Promise.all(requests);
    expect(weeks.every((w) => dates(w.days).join() === WEEK_16.join())).toBe(true);
    expect(fake.calls.weather).toHaveLength(1);
  });

  // F16
  it.each(['the later week first', 'the earlier week first'])(
    'gives overlapping refreshes across local midnight each its own week (%s)',
    async (order) => {
      const { service, fake, time } = setup({ time: fakeClock('2026-11-16T22:59:59Z') });
      const answers: ReturnType<typeof deferred<WeatherDay[]>>[] = [];
      fake.weather = () => {
        const answer = deferred<WeatherDay[]>();
        answers.push(answer);
        return answer.promise;
      };

      const pendingA = service.getWeek(WARSAW); // 23:59:59 on the 16th
      await eventually(() => fake.calls.weather.length === 1);
      time.set('2026-11-17T00:00:01+01:00'); // two seconds later, on the 17th
      const pendingB = service.getWeek(WARSAW);
      await eventually(() => fake.calls.weather.length === 2); // not joined: different weeks

      expect(fake.calls.weather.map((c) => c.dates)).toEqual([WEEK_16, WEEK_17]);

      const finishA = async () => {
        answers[0]!.resolve(weatherWeek(WEEK_16, 1));
        return pendingA;
      };
      const finishB = async () => {
        answers[1]!.resolve(weatherWeek(WEEK_17, 2));
        return pendingB;
      };
      const [weekA, weekB] =
        order === 'the later week first'
          ? await finishB().then(async (b) => [await finishA(), b] as const)
          : await finishA().then(async (a) => [a, await finishB()] as const);

      expect(dates(weekA.days)).toEqual(WEEK_16);
      expect(dates(weekB.days)).toEqual(WEEK_17);
      expect(temps(weekB.days)).toEqual([2, 2, 2, 2, 2, 2, 2]);
      expect(temps(weekA.days)).toEqual(
        order === 'the later week first' ? [1, 2, 2, 2, 2, 2, 2] : [1, 1, 1, 1, 1, 1, 1],
      );
      // Either way the shared days end with B's data, because B was requested later.
      const rows = await storedRows();
      expect(rows.map((r) => [r.date, r.tempMaxC])).toEqual([
        ['2026-11-16', 1],
        ...WEEK_17.map((d) => [d, 2]),
      ]);
    },
  );
});
