import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { buildSchema, isEnumType, isObjectType, isSpecifiedScalarType } from 'graphql';
import { addDays } from '../../src/domain/dates';
import { ACTIVITIES } from '../../src/domain/types';
import { startHttpServer } from '../../src/graphql/http';
import { createGraphQLServer } from '../../src/graphql/server';
import { typeDefs } from '../../src/graphql/schema';
import { createOpenMeteoClient } from '../../src/openmeteo/client';
import { createForecastService } from '../../src/services/forecastService';
import { createLocationService } from '../../src/services/locationService';
import { openTestDb, truncateAll } from './support/database';
import { fakeClock, recordingLogger } from './support/fakes';

const T0 = '2026-11-16T10:00:00Z';
const WEEK_16 = Array.from({ length: 7 }, (_, i) => addDays('2026-11-16', i));

const QUERY = /* GraphQL */ `
  query Rankings($city: String!) {
    activityRankings(city: $city) {
      location {
        id
        name
        country
        admin1
        latitude
        longitude
        timezone
      }
      fetchedAt
      stale
      activities {
        activity
        available
        unavailableReason
        days {
          date
          score
          rank
          reasons
        }
      }
    }
  }
`;

interface Rankings {
  location: Record<string, unknown>;
  fetchedAt: string;
  stale: boolean;
  activities: {
    activity: string;
    available: boolean;
    unavailableReason: string | null;
    days: { date: string; score: number; rank: number; reasons: string[] }[];
  }[];
}

// ---------- Open-Meteo, served from the recorded fixtures through the real client ----------

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../fixtures/openmeteo', name), 'utf8');
const reply = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });

/** A recorded forecast or marine fixture, re-dated to the week the request asked for. */
function retimed(name: string, url: URL, edit?: (daily: Record<string, unknown[]>) => void) {
  const body = JSON.parse(fixture(name)) as { daily: Record<string, unknown[]> };
  const start = url.searchParams.get('start_date')!;
  body.daily.time = body.daily.time!.map((_, i) => addDays(start, i));
  edit?.(body.daily);
  return reply(JSON.stringify(body));
}

/** The recorded Biarritz geocoding result with some fields replaced. */
function geocodeAs(fields: Record<string, unknown>) {
  const body = JSON.parse(fixture('geocode-biarritz.json')) as { results: object[] };
  body.results[0] = { ...body.results[0], ...fields };
  return reply(JSON.stringify(body));
}

const KRAKOW = {
  id: 3094802,
  name: 'Krakow',
  country: 'Poland',
  admin1: 'Lesser Poland',
  latitude: 50.06143,
  longitude: 19.93658,
  timezone: 'Europe/Warsaw',
};

type Route = (url: URL) => Response | Promise<Response>;

const { db, pool } = openTestDb();
beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

function setup(start = T0) {
  const time = fakeClock(start);
  const log = recordingLogger();
  const calls: URL[] = [];
  const routes: Record<string, Route> = {
    '/v1/search': () => reply(fixture('geocode-biarritz.json')),
    '/v1/forecast': (url) => retimed('forecast-biarritz.json', url),
    '/v1/marine': (url) => retimed('marine-biarritz.json', url),
  };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    return routes[url.pathname]!(url);
  }) as typeof fetch;

  const client = createOpenMeteoClient({
    geocodingBaseUrl: 'https://geocoding.test',
    forecastBaseUrl: 'https://forecast.test',
    marineBaseUrl: 'https://marine.test',
    timeoutMs: 1000,
    fetch: fetchFn,
  });
  const server = createGraphQLServer({
    logger: log.logger,
    locationService: createLocationService({ db, geocode: (q) => client.geocode(q) }),
    forecastService: createForecastService({
      db,
      client,
      clock: time.clock,
      forecastTtlSeconds: 3600,
      marineRetrySeconds: 300,
    }),
  });

  async function query(city: string, document = QUERY) {
    const response = await server.executeOperation({ query: document, variables: { city } });
    if (response.body.kind !== 'single') throw new Error('Expected a single result');
    const { data, errors } = response.body.singleResult;
    return {
      rankings: (data as { activityRankings?: Rankings } | null | undefined)?.activityRankings,
      errors,
      raw: JSON.stringify(response.body.singleResult),
    };
  }

  return { server, query, routes, calls, time, log };
}

const activity = (rankings: Rankings | undefined, name: string) =>
  rankings!.activities.find((a) => a.activity === name)!;

// ---------- Contract ----------

describe('contract', () => {
  // The approved contract, verbatim from the plan.
  const APPROVED = /* GraphQL */ `
    enum Activity {
      SKIING
      SURFING
      OUTDOOR_SIGHTSEEING
      INDOOR_SIGHTSEEING
    }
    enum UnavailableReason {
      NO_MARINE_DATA
      MARINE_TEMPORARILY_UNAVAILABLE
      INCOMPLETE_DATA
    }
    type Query {
      activityRankings(city: String!): ActivityRankings!
    }
    type ActivityRankings {
      location: Location!
      fetchedAt: String!
      stale: Boolean!
      activities: [ActivityRanking!]!
    }
    type Location {
      id: ID!
      name: String!
      country: String
      admin1: String
      latitude: Float!
      longitude: Float!
      timezone: String!
    }
    type ActivityRanking {
      activity: Activity!
      available: Boolean!
      unavailableReason: UnavailableReason
      days: [DayScore!]!
    }
    type DayScore {
      date: String!
      score: Int!
      rank: Int!
      reasons: [String!]!
    }
  `;

  /** Every type with its fields, arguments and exact types (descriptions ignored). */
  function signature(sdl: string): string[] {
    return Object.values(buildSchema(sdl).getTypeMap())
      .filter((type) => !type.name.startsWith('__') && !isSpecifiedScalarType(type))
      .map((type) => {
        if (isEnumType(type))
          return `enum ${type.name} { ${type
            .getValues()
            .map((v) => v.name)
            .join(' ')} }`;
        if (isObjectType(type)) {
          const fields = Object.values(type.getFields()).map((f) => {
            const args = f.args.map((a) => `${a.name}: ${String(a.type)}`).join(', ');
            return `${f.name}${args ? `(${args})` : ''}: ${String(f.type)}`;
          });
          return `type ${type.name} { ${fields.join('; ')} }`;
        }
        return `${type.constructor.name} ${type.name}`;
      })
      .sort();
  }

  it('matches the approved schema exactly', () => {
    expect(signature(typeDefs)).toEqual(signature(APPROVED));
  });
});

// ---------- Happy path and caching ----------

describe('activityRankings', () => {
  // G1
  it('returns four activities in order, each with seven ranked local days', async () => {
    const { query } = setup();
    const { rankings, errors } = await query('Biarritz');

    expect(errors).toBeUndefined();
    expect(rankings!.location).toEqual({
      id: '3032797',
      name: 'Biarritz',
      country: 'France',
      admin1: 'New Aquitaine',
      latitude: 43.48055,
      longitude: -1.55684,
      timezone: 'Europe/Paris',
    });
    expect(rankings!.fetchedAt).toBe('2026-11-16T10:00:00.000Z');
    expect(rankings!.stale).toBe(false);
    expect(rankings!.activities.map((a) => a.activity)).toEqual([...ACTIVITIES]);

    for (const { available, unavailableReason, days } of rankings!.activities) {
      expect(available).toBe(true);
      expect(unavailableReason).toBeNull();
      expect(days.map((d) => d.date)).toEqual(WEEK_16);
      for (const day of days) {
        expect(Number.isInteger(day.score) && day.score >= 0 && day.score <= 100).toBe(true);
        expect(day.rank).toBe(1 + days.filter((other) => other.score > day.score).length);
        expect(day.reasons.length).toBeGreaterThan(0);
      }
    }
  });

  // G2
  it('serves a repeated query from Postgres without calling Open-Meteo', async () => {
    const { query, calls, time } = setup();
    const first = await query('Biarritz');
    const callsAfterFirst = calls.length;

    time.advanceSeconds(60);
    const second = await query('biarritz ');
    expect(calls).toHaveLength(callsAfterFirst);
    expect(second.rankings!.fetchedAt).toBe(first.rankings!.fetchedAt);
    expect(second.rankings!.activities).toEqual(first.rankings!.activities);
  });
});

// ---------- Errors ----------

describe('errors', () => {
  // G3
  it('reports an unknown place as LOCATION_NOT_FOUND', async () => {
    const { query, routes } = setup();
    routes['/v1/search'] = () => reply(fixture('geocode-not-found.json'));

    const { rankings, errors } = await query('Zzqxqxq');
    expect(rankings).toBeUndefined();
    expect(errors).toEqual([
      expect.objectContaining({
        message: 'No location found for "Zzqxqxq"',
        extensions: { code: 'LOCATION_NOT_FOUND' },
      }),
    ]);
  });

  // G4
  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['101 characters', 'x'.repeat(101)],
  ])('rejects a %s city as BAD_USER_INPUT without calling Open-Meteo', async (_, city) => {
    const { query, calls } = setup();
    const { errors } = await query(city);

    expect(errors?.[0]?.extensions).toEqual({ code: 'BAD_USER_INPUT' });
    expect(calls).toHaveLength(0);
  });

  it('counts characters, not UTF-16 units: 100 emoji are accepted', async () => {
    const { query, routes } = setup();
    routes['/v1/search'] = () => reply(fixture('geocode-not-found.json'));
    const { errors } = await query('🌊'.repeat(100)); // 200 UTF-16 units
    expect(errors?.[0]?.extensions).toEqual({ code: 'LOCATION_NOT_FOUND' });
  });

  // G5
  it('masks an unexpected error: generic message, no details, logged in full', async () => {
    const log = recordingLogger();
    const server = createGraphQLServer({
      logger: log.logger,
      locationService: {
        resolveLocation: () => Promise.reject(new Error('secret detail: password=hunter2')),
      },
      forecastService: { getWeek: () => Promise.reject(new Error('unused')) },
    });
    const response = await server.executeOperation({ query: QUERY, variables: { city: 'X' } });
    const raw = JSON.stringify(response.body);

    expect(raw).toContain('"message":"Internal server error"');
    expect(raw).toContain('"code":"INTERNAL_SERVER_ERROR"');
    expect(raw).not.toMatch(/secret|hunter2|stacktrace|at .*\.ts/);
    expect(log.events).toContain('graphql.internal_error');
  });

  it('does not leak upstream details when Open-Meteo is down for a new city', async () => {
    const { query, routes } = setup();
    routes['/v1/search'] = () => reply('{"error":true,"reason":"maintenance"}', 503);

    const { errors, raw } = await query('Biarritz');
    expect(errors?.[0]).toEqual(
      expect.objectContaining({
        message: 'Weather data is temporarily unavailable. Please try again later.',
        extensions: { code: 'UPSTREAM_UNAVAILABLE' },
      }),
    );
    expect(raw).not.toMatch(/geocoding\.test|503|maintenance/);
  });

  it('passes GraphQL validation errors through, since they describe the client request', async () => {
    const { query } = setup();
    const { errors } = await query('Biarritz', '{ activityRankings(city: "x") { nope } }');
    expect(errors?.[0]?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it.each(['mutation', 'subscription'])(
    'rejects a %s as a validation error, not as an internal error',
    async (operation) => {
      const log = recordingLogger();
      const { query, calls } = setup();
      const server = createGraphQLServer({
        logger: log.logger,
        locationService: { resolveLocation: () => Promise.reject(new Error('unused')) },
        forecastService: { getWeek: () => Promise.reject(new Error('unused')) },
      });
      const response = await server.executeOperation({ query: `${operation} { reset }` });
      if (response.body.kind !== 'single') throw new Error('Expected a single result');

      expect(response.body.singleResult.errors).toEqual([
        expect.objectContaining({
          message: `This API does not support ${operation} operations.`,
          extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
        }),
      ]);
      expect(response.http.status).toBe(400);
      expect(log.events).not.toContain('graphql.internal_error');
      // Valid queries are unaffected by the extra rule.
      expect((await query('Biarritz')).errors).toBeUndefined();
      expect(calls.length).toBeGreaterThan(0);
    },
  );

  // Security precondition, not a feature: the @graphql-tools/utils advisory (GHSA-c4qx-w738-7hr3)
  // concerns merging incremental (@defer/@stream) payloads. If an upgrade ever enables
  // incremental delivery, this fails and the exposure analysis in docs/DECISIONS.md must be redone.
  it.each([
    ['@defer', '{ activityRankings(city: "x") { ... @defer { stale } } }'],
    ['@stream', '{ activityRankings(city: "x") { activities @stream { activity } } }'],
  ])('rejects %s: incremental delivery is not available', async (directive, document) => {
    const { query, calls } = setup();
    const { errors } = await query('Biarritz', document);

    expect(errors?.[0]).toEqual(
      expect.objectContaining({
        message: `Unknown directive "${directive}".`,
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      }),
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------- Named outcomes, each from a recorded fixture ----------

describe('named outcomes', () => {
  // G6
  it('makes surfing available on the coast', async () => {
    const { query } = setup();
    const surfing = activity((await query('Biarritz')).rankings, 'SURFING');
    expect(surfing.available).toBe(true);
    expect(surfing.days).toHaveLength(7);
  });

  // G7
  it('reports NO_MARINE_DATA inland, with no days', async () => {
    const { query, routes } = setup();
    routes['/v1/search'] = () => geocodeAs(KRAKOW);
    routes['/v1/marine'] = (url) => retimed('marine-krakow-inland.json', url);

    const { rankings } = await query('Kraków');
    expect(activity(rankings, 'SURFING')).toEqual({
      activity: 'SURFING',
      available: false,
      unavailableReason: 'NO_MARINE_DATA',
      days: [],
    });
    expect(activity(rankings, 'SKIING').available).toBe(true);
  });

  // G8
  it('answers normally in polar night (zero daylight)', async () => {
    const { query, routes } = setup();
    routes['/v1/search'] = () =>
      geocodeAs({
        id: 2729907,
        name: 'Longyearbyen',
        latitude: 78.22,
        longitude: 15.64,
        timezone: 'Arctic/Longyearbyen',
      });
    routes['/v1/forecast'] = (url) =>
      retimed('forecast-biarritz.json', url, (daily) => {
        daily.daylight_duration = daily.daylight_duration!.map(() => 0);
        daily.sunshine_duration = daily.sunshine_duration!.map(() => 0);
      });

    const { rankings, errors } = await query('Longyearbyen');
    expect(errors).toBeUndefined();
    const outdoor = activity(rankings, 'OUTDOOR_SIGHTSEEING');
    expect(outdoor.days).toHaveLength(7);
    expect(outdoor.days.every((d) => d.reasons.includes('no daylight'))).toBe(true);
  });

  // G9
  it('starts the week on the local date in a zone ahead of UTC', async () => {
    const { query, routes, calls } = setup('2026-11-16T20:00:00Z');
    routes['/v1/search'] = () =>
      geocodeAs({
        id: 2147714,
        name: 'Sydney',
        latitude: -33.86785,
        longitude: 151.20732,
        timezone: 'Australia/Sydney',
      });

    const { rankings } = await query('Sydney');
    expect(activity(rankings, 'OUTDOOR_SIGHTSEEING').days[0]!.date).toBe('2026-11-17');
    const forecastCall = calls.find((c) => c.pathname === '/v1/forecast')!;
    expect(forecastCall.searchParams.get('start_date')).toBe('2026-11-17');
    expect(forecastCall.searchParams.get('timezone')).toBe('Australia/Sydney');
  });

  // G10
  it('marks the response stale when expired weather cannot be refreshed', async () => {
    const { query, routes, time } = setup();
    await query('Biarritz');
    time.advanceSeconds(3700);
    routes['/v1/forecast'] = () => reply('{"error":true,"reason":"down"}', 503);

    const { rankings, errors } = await query('Biarritz');
    expect(errors).toBeUndefined();
    expect(rankings!.stale).toBe(true);
    expect(rankings!.fetchedAt).toBe('2026-11-16T10:00:00.000Z');
    expect(activity(rankings, 'SKIING').days).toHaveLength(7);
  });

  // G11
  it('keeps stale false and reports surfing as temporarily unavailable when marine fails', async () => {
    const { query, routes } = setup();
    routes['/v1/marine'] = () => reply('{"error":true,"reason":"down"}', 503);

    const { rankings } = await query('Biarritz');
    expect(rankings!.stale).toBe(false);
    expect(activity(rankings, 'SURFING')).toMatchObject({
      available: false,
      unavailableReason: 'MARINE_TEMPORARILY_UNAVAILABLE',
      days: [],
    });
    expect(activity(rankings, 'OUTDOOR_SIGHTSEEING').available).toBe(true);
  });
});

// ---------- Over real HTTP ----------

describe('HTTP', () => {
  /** Starts the real Express server on a free port and stops it (draining HTTP) afterwards. */
  async function withHttp(
    run: (url: string, log: ReturnType<typeof recordingLogger>) => Promise<void>,
  ) {
    const { server, log } = setup();
    const { url } = await startHttpServer(server, { port: 0, logger: log.logger });
    try {
      await run(url, log);
    } finally {
      await server.stop();
    }
  }

  const post = (url: string, body: string, contentType = 'application/json') =>
    fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });

  /** Nothing that only the server should know: stack frames, file paths, exception names. */
  const LEAK = /\/Users\/|node_modules|\.js:\d|\bat \w|SyntaxError|stack|<html/i;

  it('serves a query over HTTP', async () => {
    await withHttp(async (url) => {
      const response = await post(
        url,
        JSON.stringify({ query: QUERY, variables: { city: 'Biarritz' } }),
      );
      const body = (await response.json()) as { data: { activityRankings: Rankings } };

      expect(response.status).toBe(200);
      expect(body.data.activityRankings.location.name).toBe('Biarritz');
      expect(body.data.activityRankings.activities).toHaveLength(4);
    });
  });

  it('answers a malformed JSON body with a JSON error and no internal details', async () => {
    await withHttp(async (url, log) => {
      const response = await post(url, '{"query": ');
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(JSON.parse(text)).toEqual({
        errors: [
          { message: 'The request body is not valid JSON.', extensions: { code: 'BAD_REQUEST' } },
        ],
      });
      expect(text).not.toMatch(LEAK);
      expect(log.events).toContain('http.bad_request');
    });
  });

  it('answers an unsupported body encoding with a JSON error and no internal details', async () => {
    await withHttp(async (url) => {
      const response = await post(
        url,
        '{"query":"{ __typename }"}',
        'application/json; charset=latin1',
      );
      const text = await response.text();

      expect(response.status).toBe(415);
      expect(JSON.parse(text)).toEqual({
        errors: [
          {
            message: 'The request body encoding is not supported.',
            extensions: { code: 'BAD_REQUEST' },
          },
        ],
      });
      expect(text).not.toMatch(LEAK);
    });
  });

  it('keeps the 50 MB request limit', async () => {
    await withHttp(async (url) => {
      // One byte over the limit. body-parser rejects it from the declared length, then drains
      // the rest of the upload before answering, so the whole body is sent as a client would.
      const response = await post(url, 'x'.repeat(50 * 1024 * 1024 + 1));

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        errors: [
          { message: 'The request body is too large.', extensions: { code: 'BAD_REQUEST' } },
        ],
      });

      // ...while a 1 MB request (ten times Express's default 100 KB limit) is still accepted.
      const padded = JSON.stringify({
        query: '{ __typename }',
        extensions: { padding: 'x'.repeat(1024 * 1024) },
      });
      expect((await post(url, padded)).status).toBe(200);
    });
  });

  it('keeps CORS open to every origin, including preflight requests', async () => {
    await withHttp(async (url) => {
      const preflight = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://example.test',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');

      const response = await fetch(url, {
        method: 'POST',
        headers: { origin: 'https://example.test', 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('x-powered-by')).toBeNull();
    });
  });

  it('still blocks CSRF-prone requests and still serves the landing page', async () => {
    await withHttp(async (url) => {
      const simple = await post(url, JSON.stringify({ query: '{ __typename }' }), 'text/plain');
      expect(simple.status).toBe(400);
      expect(await simple.text()).toContain('Cross-Site Request Forgery');

      const page = await fetch(url, { headers: { accept: 'text/html' } });
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    });
  });

  it('rejects a mutation as a validation error over HTTP', async () => {
    await withHttp(async (url) => {
      const response = await post(url, JSON.stringify({ query: 'mutation { reset }' }));
      const body = (await response.json()) as { errors: { message: string; extensions: object }[] };

      expect(response.status).toBe(400);
      expect(body.errors[0]).toMatchObject({
        message: 'This API does not support mutation operations.',
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      });
    });
  });

  it('stops listening when the server is stopped', async () => {
    const { server, log } = setup();
    const { url } = await startHttpServer(server, { port: 0, logger: log.logger });
    await server.stop();

    await expect(fetch(url)).rejects.toThrow();
  });
});
