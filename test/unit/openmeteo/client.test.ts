import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  createOpenMeteoClient,
  UpstreamError,
  type UpstreamEndpoint,
  type UpstreamFailure,
} from '../../../src/openmeteo/client';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../fixtures/openmeteo', name), 'utf8');

const BIARRITZ = { latitude: 43.48055, longitude: -1.55684, timezone: 'Europe/Paris' };
const WEEK = [
  '2026-11-16',
  '2026-11-17',
  '2026-11-18',
  '2026-11-19',
  '2026-11-20',
  '2026-11-21',
  '2026-11-22',
];

type Respond = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** A fake `fetch` that records every requested URL and answers with `respond`. */
function setup(respond: Respond, timeoutMs = 1000) {
  const calls: URL[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    return respond(url, init);
  }) as typeof fetch;

  const client = createOpenMeteoClient({
    geocodingBaseUrl: 'https://geocoding.test',
    forecastBaseUrl: 'https://forecast.test',
    marineBaseUrl: 'https://marine.test',
    timeoutMs,
    fetch: fetchFn,
  });
  return { client, calls };
}

const reply = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });

interface DailyBody {
  daily_units: Record<string, string>;
  daily: Record<string, unknown[]>;
}
interface GeocodeBody {
  results: Record<string, unknown>[];
}

/** Parses a fixture, lets the test change it, and serialises it back. */
function edited<T>(name: string, edit: (body: T) => void): string {
  const body = JSON.parse(fixture(name)) as T;
  edit(body);
  return JSON.stringify(body);
}

/** Edits one daily array of a forecast or marine fixture. */
const editedDaily = (name: string, edit: (daily: DailyBody) => void) =>
  edited<DailyBody>(name, edit);

/** Edits the first geocoding result of the Biarritz fixture. */
const editedFirstResult = (edit: (result: Record<string, unknown>) => void) =>
  edited<GeocodeBody>('geocode-biarritz.json', (body) => edit(body.results[0]!));

async function expectUpstreamError(
  promise: Promise<unknown>,
  endpoint: UpstreamEndpoint,
  failure: UpstreamFailure,
  messagePart?: string | RegExp,
) {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UpstreamError);
  expect(error).toMatchObject({ endpoint, failure });
  if (messagePart !== undefined) expect((error as Error).message).toMatch(messagePart);
}

describe('geocode', () => {
  // C1
  it('returns the first match with the fields the service stores', async () => {
    const { client, calls } = setup(() => reply(fixture('geocode-biarritz.json')));

    await expect(client.geocode('Biarritz')).resolves.toEqual({
      kind: 'found',
      location: {
        id: 3032797,
        name: 'Biarritz',
        country: 'France',
        admin1: 'New Aquitaine',
        latitude: 43.48055,
        longitude: -1.55684,
        timezone: 'Europe/Paris',
      },
    });
    expect(calls[0]!.origin + calls[0]!.pathname).toBe('https://geocoding.test/v1/search');
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({
      name: 'Biarritz',
      count: '1',
      language: 'en',
      format: 'json',
    });
  });

  it('sends the query as a parameter, never as part of the host or path', async () => {
    const { client, calls } = setup(() => reply(fixture('geocode-not-found.json')));
    await client.geocode('../evil.example/x?y=1&count=99');

    expect(calls[0]!.host).toBe('geocoding.test');
    expect(calls[0]!.pathname).toBe('/v1/search');
    expect(calls[0]!.searchParams.get('name')).toBe('../evil.example/x?y=1&count=99');
    expect(calls[0]!.searchParams.get('count')).toBe('1');
  });

  it('maps missing country and region to null', async () => {
    const body = editedFirstResult((r) => {
      delete r.country;
      delete r.admin1;
    });
    const { client } = setup(() => reply(body));

    await expect(client.geocode('Biarritz')).resolves.toMatchObject({
      location: { country: null, admin1: null },
    });
  });

  // C2, C3
  it('returns not_found when there is no results key', async () => {
    const { client } = setup(() => reply(fixture('geocode-not-found.json')));
    await expect(client.geocode('Zzqxqxq')).resolves.toEqual({ kind: 'not_found' });
  });

  it('returns not_found when results is empty', async () => {
    const { client } = setup(() => reply('{"results":[],"generationtime_ms":0.1}'));
    await expect(client.geocode('Zzqxqxq')).resolves.toEqual({ kind: 'not_found' });
  });

  // C4
  it('fails with an http UpstreamError on a server error', async () => {
    const { client } = setup(() => reply('Internal Server Error', 500));
    await expectUpstreamError(client.geocode('Biarritz'), 'geocoding', 'http', 'HTTP 500');
  });

  it('fails with invalid_body when the body is not JSON', async () => {
    const { client } = setup(() => reply('<html>maintenance</html>'));
    await expectUpstreamError(client.geocode('Biarritz'), 'geocoding', 'invalid_body', 'JSON');
  });

  it.each<[string, (result: Record<string, unknown>) => void, RegExp]>([
    ['no time zone', (r) => delete r.timezone, /timezone/],
    ['an unknown time zone', (r) => (r.timezone = 'Mars/Olympus_Mons'), /time zone/],
    ['no coordinates', (r) => delete r.latitude, /latitude/],
    ['a latitude out of range', (r) => (r.latitude = 123), /latitude/],
    ['a latitude just below -90', (r) => (r.latitude = -90.0001), /latitude/],
    ['a longitude out of range', (r) => (r.longitude = 200), /longitude/],
    ['a longitude just below -180', (r) => (r.longitude = -180.0001), /longitude/],
    ['a coordinate sent as a string', (r) => (r.longitude = '-1.55684'), /longitude/],
    ['an id that is not a positive integer', (r) => (r.id = -4), /id/],
  ])('fails with invalid_body when the first result has %s', async (_, edit, message) => {
    const body = editedFirstResult(edit);
    const { client } = setup(() => reply(body));
    await expectUpstreamError(client.geocode('Biarritz'), 'geocoding', 'invalid_body', message);
  });

  it.each([
    ['latitude', '"latitude":43.48055', '"latitude":1e999'],
    ['longitude', '"longitude":-1.55684', '"longitude":-1e999'],
  ])('fails with invalid_body when the %s is non-finite (JSON 1e999)', async (field, from, to) => {
    const body = fixture('geocode-biarritz.json').replace(from, to);
    expect(body).toContain(to);
    const { client } = setup(() => reply(body));
    await expectUpstreamError(client.geocode('Biarritz'), 'geocoding', 'invalid_body', field);
  });

  it('accepts coordinates exactly on the limits', async () => {
    const body = editedFirstResult((r) => {
      r.latitude = -90;
      r.longitude = 180;
    });
    const { client } = setup(() => reply(body));
    await expect(client.geocode('South Pole')).resolves.toMatchObject({
      location: { latitude: -90, longitude: 180 },
    });
  });
});

describe('coordinates sent to the forecast and marine APIs', () => {
  const invalidPoints: [string, number, number][] = [
    ['NaN latitude', NaN, 10],
    ['NaN longitude', 10, NaN],
    ['infinite latitude', Infinity, 10],
    ['negative infinite longitude', 10, -Infinity],
    ['latitude above 90', 90.0001, 10],
    ['longitude below -180', 10, -180.5],
  ];

  it.each(invalidPoints)(
    'refuses %s before sending any request',
    async (_, latitude, longitude) => {
      const { client, calls } = setup(() => reply(fixture('forecast-biarritz.json')));
      const point = { latitude, longitude, timezone: 'Europe/Paris' };

      await expect(client.fetchWeather(point, WEEK)).rejects.toThrow(RangeError);
      await expect(client.fetchMarine(point, WEEK)).rejects.toThrow(/Invalid coordinates/);
      expect(calls).toHaveLength(0);
    },
  );

  it('sends coordinates exactly on the limits', async () => {
    const { client, calls } = setup(() => reply(fixture('marine-biarritz.json')));
    await client.fetchMarine({ latitude: 90, longitude: -180, timezone: 'Europe/Paris' }, WEEK);

    expect(calls[0]!.searchParams.get('latitude')).toBe('90');
    expect(calls[0]!.searchParams.get('longitude')).toBe('-180');
  });
});

describe('fetchWeather', () => {
  // C5
  it('requests the location time zone, the exact dates and pinned units', async () => {
    const { client, calls } = setup(() => reply(fixture('forecast-biarritz.json')));
    await client.fetchWeather(BIARRITZ, WEEK);

    expect(calls[0]!.origin + calls[0]!.pathname).toBe('https://forecast.test/v1/forecast');
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({
      latitude: '43.48055',
      longitude: '-1.55684',
      timezone: 'Europe/Paris',
      start_date: '2026-11-16',
      end_date: '2026-11-22',
      daily:
        'temperature_2m_max,precipitation_sum,snowfall_sum,snow_depth_max,wind_speed_10m_max,sunshine_duration,daylight_duration',
      temperature_unit: 'celsius',
      wind_speed_unit: 'kmh',
      precipitation_unit: 'mm',
    });
  });

  it('maps every day to unit-suffixed fields', async () => {
    const { client } = setup(() => reply(fixture('forecast-biarritz.json')));
    const days = await client.fetchWeather(BIARRITZ, WEEK);

    expect(days.map((d) => d.date)).toEqual(WEEK);
    expect(days[0]).toEqual({
      date: '2026-11-16',
      tempMaxC: 20.3,
      precipitationMm: 0,
      snowfallCm: 0,
      snowDepthM: 0,
      windSpeedMaxKmh: 25.8,
      sunshineS: 26181.74,
      daylightS: 34770.62,
    });
    expect(days[2]).toMatchObject({ precipitationMm: 23.08, windSpeedMaxKmh: 43.3 });
  });

  it('keeps a null value as missing data, not as a failure', async () => {
    const body = editedDaily(
      'forecast-biarritz.json',
      (b) => (b.daily.precipitation_sum![2] = null),
    );
    const { client } = setup(() => reply(body));
    const days = await client.fetchWeather(BIARRITZ, WEEK);

    expect(days[2]!.precipitationMm).toBeNull();
    expect(days[3]!.precipitationMm).toBe(10.7);
  });

  it.each<[string, () => string, RegExp]>([
    [
      'a non-finite number (1e999 parses to Infinity)',
      () =>
        fixture('forecast-biarritz.json').replace(
          '"temperature_2m_max":[20.3',
          '"temperature_2m_max":[1e999',
        ),
      /temperature_2m_max.*2026-11-16/,
    ],
    [
      'negative precipitation',
      () => editedDaily('forecast-biarritz.json', (b) => (b.daily.precipitation_sum![3] = -1)),
      /precipitation_sum.*2026-11-19/,
    ],
    [
      'an implausible temperature',
      () => editedDaily('forecast-biarritz.json', (b) => (b.daily.temperature_2m_max![6] = 150)),
      /temperature_2m_max.*2026-11-22/,
    ],
    [
      'a number sent as a string',
      () => editedDaily('forecast-biarritz.json', (b) => (b.daily.wind_speed_10m_max![1] = '33.5')),
      /wind_speed_10m_max.*2026-11-17/,
    ],
    [
      'snow depth in a different unit',
      () => editedDaily('forecast-biarritz.json', (b) => (b.daily_units.snow_depth_max = 'cm')),
      /snow_depth_max/,
    ],
    [
      'a variable missing entirely',
      () => editedDaily('forecast-biarritz.json', (b) => delete b.daily.sunshine_duration),
      /sunshine_duration/,
    ],
    [
      'one day too few for a variable',
      () => editedDaily('forecast-biarritz.json', (b) => b.daily.daylight_duration!.pop()),
      /daylight_duration/,
    ],
  ])('rejects the whole response on %s (invalid, not missing)', async (_, body, message) => {
    const { client } = setup(() => reply(body()));
    await expectUpstreamError(
      client.fetchWeather(BIARRITZ, WEEK),
      'forecast',
      'invalid_body',
      message,
    );
  });

  // C7
  it('rejects a response for other dates than those requested', async () => {
    const shifted = [...WEEK.slice(1), '2026-11-23'];
    const { client } = setup(() => reply(fixture('forecast-biarritz.json')));
    await expectUpstreamError(
      client.fetchWeather(BIARRITZ, shifted),
      'forecast',
      'invalid_body',
      /2026-11-16.*2026-11-17/,
    );
  });

  it('passes the error reason of an HTTP 400 through', async () => {
    const { client } = setup(() => reply(fixture('forecast-error-400.json'), 400));
    await expectUpstreamError(
      client.fetchWeather(BIARRITZ, WEEK),
      'forecast',
      'http',
      /HTTP 400: Latitude must be in range/,
    );
  });

  // C8
  it('fails with a timeout UpstreamError when the API does not answer in time', async () => {
    const { client } = setup(
      (_, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
        }),
      20,
    );
    await expectUpstreamError(client.fetchWeather(BIARRITZ, WEEK), 'forecast', 'timeout', /20 ms/);
  });

  it('fails with a network UpstreamError when the request cannot be sent', async () => {
    const { client } = setup(() => Promise.reject(new TypeError('fetch failed')));
    await expectUpstreamError(
      client.fetchWeather(BIARRITZ, WEEK),
      'forecast',
      'network',
      /fetch failed/,
    );
  });
});

describe('fetchMarine', () => {
  it('maps the coastal wave forecast', async () => {
    const { client, calls } = setup(() => reply(fixture('marine-biarritz.json')));
    const days = await client.fetchMarine(BIARRITZ, WEEK);

    expect(calls[0]!.origin + calls[0]!.pathname).toBe('https://marine.test/v1/marine');
    expect(calls[0]!.searchParams.get('daily')).toBe('wave_height_max,swell_wave_period_max');
    expect(calls[0]!.searchParams.get('timezone')).toBe('Europe/Paris');
    expect(days[0]).toEqual({ date: '2026-11-16', waveHeightMaxM: 2.4, swellPeriodMaxS: 8.3 });
    expect(days.map((d) => d.date)).toEqual(WEEK);
  });

  // C6
  it('treats an all-null inland response as a success with missing values', async () => {
    const { client } = setup(() => reply(fixture('marine-krakow-inland.json')));
    const krakow = { latitude: 50.06143, longitude: 19.93658, timezone: 'Europe/Warsaw' };
    const days = await client.fetchMarine(krakow, WEEK);

    expect(days).toHaveLength(7);
    expect(days.every((d) => d.waveHeightMaxM === null && d.swellPeriodMaxS === null)).toBe(true);
  });

  it('rejects an implausible wave height', async () => {
    const body = editedDaily('marine-biarritz.json', (b) => (b.daily.wave_height_max![4] = 99));
    const { client } = setup(() => reply(body));
    await expectUpstreamError(
      client.fetchMarine(BIARRITZ, WEEK),
      'marine',
      'invalid_body',
      /wave_height_max.*2026-11-20/,
    );
  });
});
