import type {
  ForecastPoint,
  GeocodeResult,
  MarineDay,
  OpenMeteoClient,
  WeatherDay,
} from '../../../src/openmeteo/client';
import { UpstreamError } from '../../../src/openmeteo/client';
import type { Logger } from '../../../src/services/logger';

/** A promise the test settles by hand, to control the order of concurrent work. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Waits for a condition by yielding to the event loop (database I/O included), never by sleeping. */
export async function eventually(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function fakeClock(iso: string) {
  let now = new Date(iso).getTime();
  return {
    clock: () => new Date(now),
    set: (next: string) => (now = new Date(next).getTime()),
    advanceSeconds: (seconds: number) => (now += seconds * 1000),
  };
}

/** A week of weather whose temperature is `marker`, so a test can tell which refresh wrote it. */
export function weatherWeek(dates: readonly string[], marker: number): WeatherDay[] {
  return dates.map((date) => ({
    date,
    tempMaxC: marker,
    precipitationMm: 0,
    snowfallCm: 0,
    snowDepthM: 0,
    windSpeedMaxKmh: 10,
    sunshineS: 20_000,
    daylightS: 36_000,
  }));
}

export function marineWeek(dates: readonly string[], waveHeightM: number): MarineDay[] {
  return dates.map((date) => ({ date, waveHeightMaxM: waveHeightM, swellPeriodMaxS: 10 }));
}

export function inlandMarine(dates: readonly string[]): MarineDay[] {
  return dates.map((date) => ({ date, waveHeightMaxM: null, swellPeriodMaxS: null }));
}

export const upstreamDown = (endpoint: 'forecast' | 'marine' | 'geocoding') =>
  new UpstreamError(endpoint, 'http', 'HTTP 503');

type Call = { point: ForecastPoint; dates: string[] };

export interface FakeForecastClient {
  /** Every request made, in order. */
  calls: { weather: Call[]; marine: Call[] };
  /** How the next weather request is answered; tests replace it. */
  weather: (dates: readonly string[], point: ForecastPoint) => Promise<WeatherDay[]>;
  /** How the next marine request is answered; tests replace it. */
  marine: (dates: readonly string[], point: ForecastPoint) => Promise<MarineDay[]>;
  client: Pick<OpenMeteoClient, 'fetchWeather' | 'fetchMarine'>;
}

/**
 * A forecast client whose answers each test sets. Every call is recorded; by default it
 * answers immediately with marker 1 and a 1.5 m sea.
 */
export function fakeForecastClient(): FakeForecastClient {
  const calls = { weather: [] as Call[], marine: [] as Call[] };
  const fake: FakeForecastClient = {
    calls,
    weather: (dates) => Promise.resolve(weatherWeek(dates, 1)),
    marine: (dates) => Promise.resolve(marineWeek(dates, 1.5)),
    client: {
      fetchWeather: (point, dates) => {
        calls.weather.push({ point, dates: [...dates] });
        return fake.weather(dates, point);
      },
      fetchMarine: (point, dates) => {
        calls.marine.push({ point, dates: [...dates] });
        return fake.marine(dates, point);
      },
    },
  };
  return fake;
}

export function fakeGeocoder(answer: (query: string) => Promise<GeocodeResult>) {
  const calls: string[] = [];
  return {
    calls,
    geocode: (query: string) => {
      calls.push(query);
      return answer(query);
    },
  };
}

/** Records event names, e.g. to wait until N requests have missed the cache. */
export function recordingLogger() {
  const events: string[] = [];
  const logger: Logger = {
    info: (_fields, event) => events.push(event),
    warn: (_fields, event) => events.push(event),
  };
  return { logger, events, count: (event: string) => events.filter((e) => e === event).length };
}
