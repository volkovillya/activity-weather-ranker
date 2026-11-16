import { z } from 'zod';
import type { DailyWeather } from '../domain/types';

export type UpstreamEndpoint = 'geocoding' | 'forecast' | 'marine';
export type UpstreamFailure = 'http' | 'network' | 'timeout' | 'invalid_body';

/** Every way an Open-Meteo call can fail. "Location not found" is not a failure: it is a value. */
export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';

  constructor(
    readonly endpoint: UpstreamEndpoint,
    readonly failure: UpstreamFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Open-Meteo ${endpoint}: ${message}`, options);
  }
}

export interface GeoLocation {
  /** Open-Meteo's geocoding id; stable, used as our primary key. */
  id: number;
  name: string;
  country: string | null;
  admin1: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
}

export type GeocodeResult = { kind: 'found'; location: GeoLocation } | { kind: 'not_found' };

export type ForecastPoint = Pick<GeoLocation, 'latitude' | 'longitude' | 'timezone'>;

export type WeatherDay = Pick<
  DailyWeather,
  | 'date'
  | 'tempMaxC'
  | 'precipitationMm'
  | 'snowfallCm'
  | 'snowDepthM'
  | 'windSpeedMaxKmh'
  | 'sunshineS'
  | 'daylightS'
>;

export type MarineDay = Pick<DailyWeather, 'date' | 'waveHeightMaxM' | 'swellPeriodMaxS'>;

export interface OpenMeteoClient {
  geocode(query: string): Promise<GeocodeResult>;
  fetchWeather(point: ForecastPoint, dates: readonly string[]): Promise<WeatherDay[]>;
  fetchMarine(point: ForecastPoint, dates: readonly string[]): Promise<MarineDay[]>;
}

export interface OpenMeteoClientOptions {
  geocodingBaseUrl: string;
  forecastBaseUrl: string;
  marineBaseUrl: string;
  /** Applies to each request separately, including reading its body. */
  timeoutMs: number;
  fetch?: typeof fetch;
}

/**
 * One daily variable: the Open-Meteo parameter, our field, the unit we pin and expect back, and
 * a generous physical range. A value outside the range is invalid data, not weather.
 */
interface DailyVariable<F extends string> {
  param: string;
  field: F;
  unit: string;
  min: number;
  max: number;
}

const WEATHER_VARIABLES = [
  // Records: −89.2 °C and 56.7 °C.
  { param: 'temperature_2m_max', field: 'tempMaxC', unit: '°C', min: -100, max: 70 },
  // Record daily rainfall is about 1 825 mm.
  { param: 'precipitation_sum', field: 'precipitationMm', unit: 'mm', min: 0, max: 2000 },
  { param: 'snowfall_sum', field: 'snowfallCm', unit: 'cm', min: 0, max: 1000 },
  // Open-Meteo reports about 20 m on the Greenland and Antarctic ice sheets.
  { param: 'snow_depth_max', field: 'snowDepthM', unit: 'm', min: 0, max: 100 },
  // Record gust is about 408 km/h.
  { param: 'wind_speed_10m_max', field: 'windSpeedMaxKmh', unit: 'km/h', min: 0, max: 500 },
  // Up to 25 hours (90 000 s), the length of a local day when clocks go back.
  { param: 'sunshine_duration', field: 'sunshineS', unit: 's', min: 0, max: 90_000 },
  { param: 'daylight_duration', field: 'daylightS', unit: 's', min: 0, max: 90_000 },
] as const satisfies readonly DailyVariable<keyof WeatherDay>[];

const MARINE_VARIABLES = [
  // The largest waves measured are about 30 m.
  { param: 'wave_height_max', field: 'waveHeightMaxM', unit: 'm', min: 0, max: 40 },
  { param: 'swell_wave_period_max', field: 'swellPeriodMaxS', unit: 's', min: 0, max: 40 },
] as const satisfies readonly DailyVariable<keyof MarineDay>[];

const GeocodeBody = z.object({ results: z.array(z.unknown()).optional() });

const GeocodeResultSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().refine(isKnownTimeZone, 'is not a known time zone'),
  country: z.string().optional(),
  admin1: z.string().optional(),
});

function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function createOpenMeteoClient(options: OpenMeteoClientOptions): OpenMeteoClient {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const { timeoutMs } = options;

  async function getJson(endpoint: UpstreamEndpoint, url: URL): Promise<unknown> {
    const transportError = (error: unknown) =>
      error instanceof DOMException && error.name === 'TimeoutError'
        ? new UpstreamError(endpoint, 'timeout', `no response within ${timeoutMs} ms`, {
            cause: error,
          })
        : new UpstreamError(endpoint, 'network', `request failed: ${errorMessage(error)}`, {
            cause: error,
          });

    let text: string;
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        throw new UpstreamError(
          endpoint,
          'http',
          `HTTP ${response.status}${await reason(response)}`,
        );
      }
      text = await response.text();
    } catch (error) {
      throw error instanceof UpstreamError ? error : transportError(error);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new UpstreamError(endpoint, 'invalid_body', 'response is not valid JSON', {
        cause: error,
      });
    }
  }

  return {
    async geocode(query) {
      const url = buildUrl(options.geocodingBaseUrl, '/v1/search', {
        name: query,
        count: '1',
        language: 'en',
        format: 'json',
      });
      const body = validate('geocoding', GeocodeBody, await getJson('geocoding', url));

      const first = body.results?.[0];
      if (first === undefined) return { kind: 'not_found' };

      const result = validate('geocoding', GeocodeResultSchema, first, { label: 'first result' });
      return {
        kind: 'found',
        location: {
          id: result.id,
          name: result.name,
          country: result.country ?? null,
          admin1: result.admin1 ?? null,
          latitude: result.latitude,
          longitude: result.longitude,
          timezone: result.timezone,
        },
      };
    },

    async fetchWeather(point, dates) {
      const url = buildUrl(options.forecastBaseUrl, '/v1/forecast', {
        ...dailyParams(point, dates, WEATHER_VARIABLES),
        // Pinned even though they are the defaults; the response's daily_units are checked too.
        temperature_unit: 'celsius',
        wind_speed_unit: 'kmh',
        precipitation_unit: 'mm',
      });
      return parseDaily('forecast', await getJson('forecast', url), WEATHER_VARIABLES, dates);
    },

    async fetchMarine(point, dates) {
      const url = buildUrl(
        options.marineBaseUrl,
        '/v1/marine',
        dailyParams(point, dates, MARINE_VARIABLES),
      );
      return parseDaily('marine', await getJson('marine', url), MARINE_VARIABLES, dates);
    },
  };
}

/** User text only ever becomes a query parameter, never part of the host or path. */
function buildUrl(baseUrl: string, path: string, params: Record<string, string>): URL {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function dailyParams(
  point: ForecastPoint,
  dates: readonly string[],
  variables: readonly DailyVariable<string>[],
): Record<string, string> {
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) throw new Error('At least one date is required');

  // Coordinates come from our own stored locations, so a bad one is a bug, not an upstream
  // failure: refuse before sending anything (String(NaN) would otherwise go out as "NaN").
  const { latitude, longitude } = point;
  if (!isInRange(latitude, -90, 90) || !isInRange(longitude, -180, 180)) {
    throw new RangeError(`Invalid coordinates: latitude ${latitude}, longitude ${longitude}`);
  }

  return {
    latitude: String(point.latitude),
    longitude: String(point.longitude),
    // Explicit zone and dates, so the days returned are exactly the local days we asked for.
    timezone: point.timezone,
    start_date: first,
    end_date: last,
    daily: variables.map((v) => v.param).join(','),
  };
}

/**
 * Validates a daily response and maps it to one object per requested date.
 * - Missing values (JSON null) are kept as null: the domain treats them as unavailable data.
 * - Invalid values (wrong type, non-finite, outside the variable's range), a unit we did not ask
 *   for, a missing variable or days other than those requested reject the whole response.
 */
function parseDaily<F extends string>(
  endpoint: UpstreamEndpoint,
  body: unknown,
  variables: readonly DailyVariable<F>[],
  dates: readonly string[],
): ({ date: string } & Record<F, number | null>)[] {
  const schema = z.object({
    daily_units: z.object(Object.fromEntries(variables.map((v) => [v.param, z.literal(v.unit)]))),
    daily: z.object({
      time: z.array(z.string()),
      ...Object.fromEntries(
        variables.map((v) => [
          v.param,
          z.array(z.number().min(v.min).max(v.max).nullable()).length(dates.length),
        ]),
      ),
    }),
  });
  const { daily } = validate(endpoint, schema, body, { dates });

  if (daily.time.join() !== dates.join()) {
    throw new UpstreamError(
      endpoint,
      'invalid_body',
      `returned dates ${daily.time[0]}…${daily.time.at(-1)}, expected ${dates[0]}…${dates.at(-1)}`,
    );
  }

  const values = daily as unknown as Record<string, (number | null)[]>;
  return dates.map(
    (date, i) =>
      ({
        date,
        ...Object.fromEntries(variables.map((v) => [v.field, values[v.param]?.[i] ?? null])),
      }) as { date: string } & Record<F, number | null>,
  );
}

/** Parses with zod and turns the first problem into an UpstreamError naming the field and day. */
function validate<T>(
  endpoint: UpstreamEndpoint,
  schema: z.ZodType<T>,
  body: unknown,
  context: { dates?: readonly string[]; label?: string } = {},
): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const [section, variable, index] = issue?.path ?? [];
  const day = typeof index === 'number' ? context.dates?.[index] : undefined;
  const where =
    section === 'daily' && day !== undefined
      ? `${String(variable)} on ${day}`
      : [context.label, ...(issue?.path ?? []).map(String)].filter(Boolean).join('.');
  throw new UpstreamError(endpoint, 'invalid_body', `${where}: ${issue?.message ?? 'invalid'}`);
}

async function reason(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body === 'object' && body !== null && 'reason' in body) {
      return typeof body.reason === 'string' ? `: ${body.reason.slice(0, 200)}` : '';
    }
  } catch {
    // An error body that is not JSON adds nothing worth reporting.
  }
  return '';
}

/** False for NaN and ±Infinity as well as for finite values outside [min, max]. */
function isInRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
