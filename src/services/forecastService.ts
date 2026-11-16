import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client';
import { dailyForecasts } from '../db/schema';
import { weekDates } from '../domain/dates';
import type { DailyWeather } from '../domain/types';
import { UpstreamError, type OpenMeteoClient } from '../openmeteo/client';
import { UpstreamUnavailableError } from './errors';
import { silentLogger, type Logger } from './logger';
import type { StoredLocation } from './locationService';

export type Clock = () => Date;

type RefreshOutcome = 'refreshed' | 'weather_failed';
type StoredDay = DailyWeather & { fetchedAt: Date };
type ForecastLocation = Pick<StoredLocation, 'id' | 'latitude' | 'longitude' | 'timezone'>;

export interface ForecastWeek {
  /** The seven requested local dates, in order. Always complete. */
  days: DailyWeather[];
  /** When the oldest of the seven rows was requested from Open-Meteo. */
  fetchedAt: Date;
  /**
   * True only when this request tried to refresh weather older than the TTL and the attempt
   * failed, so older data was served. Not a measure of age, and never about marine data.
   */
  stale: boolean;
}

export interface ForecastServiceDeps {
  db: Db;
  client: Pick<OpenMeteoClient, 'fetchWeather' | 'fetchMarine'>;
  clock: Clock;
  forecastTtlSeconds: number;
  marineRetrySeconds: number;
  logger?: Logger;
}

/** The value the conflicting insert proposed for this column (Postgres `EXCLUDED`). */
const excluded = (column: AnyPgColumn) => sql`excluded.${sql.identifier(column.name)}`;

export function createForecastService(deps: ForecastServiceDeps) {
  const { db, client, clock, logger = silentLogger } = deps;
  const ttlMs = deps.forecastTtlSeconds * 1000;
  const marineRetryMs = deps.marineRetrySeconds * 1000;

  /** Refreshes in progress in this process, keyed by location and week (its first date). */
  const inFlight = new Map<string, Promise<RefreshOutcome>>();

  /** The stored rows for exactly these dates, or null unless every date has a row. */
  async function readWeek(
    locationId: number,
    dates: readonly string[],
  ): Promise<StoredDay[] | null> {
    const rows = await db
      .select()
      .from(dailyForecasts)
      .where(
        and(eq(dailyForecasts.locationId, locationId), inArray(dailyForecasts.date, [...dates])),
      );
    const byDate = new Map(rows.map(({ locationId, ...day }) => [day.date, day]));
    const days = dates.map((date) => byDate.get(date));
    return days.every((day) => day !== undefined) ? days : null;
  }

  const oldest = (days: readonly StoredDay[]) =>
    Math.min(...days.map((day) => day.fetchedAt.getTime()));

  /** Weather younger than the TTL. Strict, so a TTL of 0 is never fresh. */
  const isWeatherFresh = (days: readonly StoredDay[], now: Date) =>
    now.getTime() - oldest(days) < ttlMs;

  /** A day was written without marine data because that request failed, long enough ago. */
  function isMarineRetryDue(days: readonly StoredDay[], now: Date): boolean {
    const failed = days.filter((day) => !day.marineFetched);
    return failed.length > 0 && now.getTime() - oldest(failed) >= marineRetryMs;
  }

  async function refresh(
    location: ForecastLocation,
    dates: readonly string[],
  ): Promise<RefreshOutcome> {
    // Taken before either call, so a refresh requested later always wins, however long the
    // slower of its two calls takes.
    const requestedAt = clock();
    const started = performance.now();

    const [weather, marine] = await Promise.allSettled([
      client.fetchWeather(location, dates),
      client.fetchMarine(location, dates),
    ]);
    for (const result of [weather, marine]) {
      if (result.status === 'rejected' && !(result.reason instanceof UpstreamError)) {
        throw result.reason; // a bug, not an outage
      }
    }

    const log = {
      locationId: location.id,
      firstDate: dates[0],
      ms: Math.round(performance.now() - started),
    };
    if (weather.status === 'rejected') {
      logger.warn({ ...log, error: errorMessage(weather.reason) }, 'forecast.refresh_failed');
      return 'weather_failed';
    }
    const marineDays = marine.status === 'fulfilled' ? marine.value : null;
    if (marine.status === 'rejected') {
      logger.warn({ ...log, error: errorMessage(marine.reason) }, 'forecast.marine_failed');
    }

    // The client guarantees both arrays hold exactly `dates`, in order (ascending, which also
    // makes overlapping upserts take row locks in the same order).
    const rows = weather.value.map((day, i) => ({
      ...day,
      locationId: location.id,
      fetchedAt: requestedAt,
      marineFetched: marineDays !== null,
      waveHeightMaxM: marineDays?.[i]?.waveHeightMaxM ?? null,
      swellPeriodMaxS: marineDays?.[i]?.swellPeriodMaxS ?? null,
    }));

    const t = dailyForecasts;
    await db
      .insert(t)
      .values(rows)
      .onConflictDoUpdate({
        target: [t.locationId, t.date],
        set: {
          fetchedAt: excluded(t.fetchedAt),
          marineFetched: excluded(t.marineFetched),
          tempMaxC: excluded(t.tempMaxC),
          precipitationMm: excluded(t.precipitationMm),
          snowfallCm: excluded(t.snowfallCm),
          snowDepthM: excluded(t.snowDepthM),
          windSpeedMaxKmh: excluded(t.windSpeedMaxKmh),
          sunshineS: excluded(t.sunshineS),
          daylightS: excluded(t.daylightS),
          waveHeightMaxM: excluded(t.waveHeightMaxM),
          swellPeriodMaxS: excluded(t.swellPeriodMaxS),
        },
        // Only a refresh requested later may replace a row.
        setWhere: sql`${t.fetchedAt} < excluded.fetched_at`,
      });

    logger.info({ ...log, marineFetched: marineDays !== null }, 'forecast.refreshed');
    return 'refreshed';
  }

  /** Concurrent requests for the same location and week share one refresh. */
  function refreshOnce(
    location: ForecastLocation,
    dates: readonly string[],
  ): Promise<RefreshOutcome> {
    const key = `${location.id}:${dates[0]}`;
    const running = inFlight.get(key);
    if (running) return running;

    // Stored before anything is awaited, and removed however it settles: a failed refresh is
    // never cached, so the next request simply tries again.
    const promise = refresh(location, dates).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  return {
    async getWeek(location: ForecastLocation): Promise<ForecastWeek> {
      const dates = weekDates(location.timezone, clock());
      const stored = await readWeek(location.id, dates);

      const now = clock();
      if (stored && isWeatherFresh(stored, now) && !isMarineRetryDue(stored, now)) {
        logger.info({ locationId: location.id, firstDate: dates[0] }, 'forecast.cache_hit');
        return toWeek(stored, false);
      }

      logger.info({ locationId: location.id, firstDate: dates[0] }, 'forecast.cache_miss');
      const outcome = await refreshOnce(location, dates);

      // Always serve what Postgres holds, never the upstream payload: a concurrent refresh may
      // have written newer rows, and data that failed to persist must not be returned.
      const week = await readWeek(location.id, dates);
      if (!week) {
        if (outcome === 'weather_failed') {
          throw new UpstreamUnavailableError(
            'The weather forecast is unavailable and no complete stored week exists',
          );
        }
        throw new Error(`Week ${dates[0]} of location ${location.id} incomplete after a refresh`);
      }
      return toWeek(week, outcome === 'weather_failed' && !isWeatherFresh(week, clock()));
    },
  };
}

export type ForecastService = ReturnType<typeof createForecastService>;

function toWeek(days: StoredDay[], stale: boolean): ForecastWeek {
  return {
    days: days.map(({ fetchedAt, ...day }) => day),
    fetchedAt: new Date(Math.min(...days.map((day) => day.fetchedAt.getTime()))),
    stale,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
