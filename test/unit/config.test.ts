import { describe, expect, it } from '@jest/globals';
import { loadConfig } from '../../src/config';

const DATABASE_URL = 'postgres://ranker:secret-password@localhost:5432/ranker';

describe('loadConfig', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      port: 4000,
      forecastTtlSeconds: 3600,
      marineRetrySeconds: 300,
      upstreamTimeoutMs: 3000,
      upstreamMaxConcurrent: 10,
      dbConnectionTimeoutMs: 5000,
      dbStatementTimeoutMs: 5000,
      dbPoolMax: 10,
      openMeteo: {
        geocodingBaseUrl: 'https://geocoding-api.open-meteo.com',
        forecastBaseUrl: 'https://api.open-meteo.com',
        marineBaseUrl: 'https://marine-api.open-meteo.com',
      },
    });
  });

  it('parses overrides as integers', () => {
    const config = loadConfig({
      DATABASE_URL,
      PORT: '8080',
      FORECAST_TTL_SECONDS: '60',
      MARINE_RETRY_SECONDS: '30',
      UPSTREAM_TIMEOUT_MS: '500',
      UPSTREAM_MAX_CONCURRENT: '4',
      DB_CONNECTION_TIMEOUT_MS: '1500',
      DB_STATEMENT_TIMEOUT_MS: '2500',
      DB_POOL_MAX: '25',
      MARINE_BASE_URL: 'http://localhost:9999',
    });

    expect(config.port).toBe(8080);
    expect(config.forecastTtlSeconds).toBe(60);
    expect(config.marineRetrySeconds).toBe(30);
    expect(config.upstreamTimeoutMs).toBe(500);
    expect(config.upstreamMaxConcurrent).toBe(4);
    expect(config.dbConnectionTimeoutMs).toBe(1500);
    expect(config.dbStatementTimeoutMs).toBe(2500);
    expect(config.dbPoolMax).toBe(25);
    expect(config.openMeteo.marineBaseUrl).toBe('http://localhost:9999');
  });

  it('accepts 0 for the TTL and the marine retry window', () => {
    const config = loadConfig({
      DATABASE_URL,
      FORECAST_TTL_SECONDS: '0',
      MARINE_RETRY_SECONDS: '0',
    });

    expect(config.forecastTtlSeconds).toBe(0);
    expect(config.marineRetrySeconds).toBe(0);
  });

  it.each(['', '-1', '1.5', 'abc', ' 60', '1e3'])(
    'rejects FORECAST_TTL_SECONDS=%j instead of coercing it',
    (value) => {
      expect(() => loadConfig({ DATABASE_URL, FORECAST_TTL_SECONDS: value })).toThrow(
        /FORECAST_TTL_SECONDS must be a non-negative integer/,
      );
    },
  );

  it.each(['UPSTREAM_TIMEOUT_MS', 'DB_CONNECTION_TIMEOUT_MS', 'DB_STATEMENT_TIMEOUT_MS'])(
    'rejects a zero %s (0 would mean "wait forever")',
    (name) => {
      expect(() => loadConfig({ DATABASE_URL, [name]: '0' })).toThrow(
        new RegExp(`${name} must be greater than 0`),
      );
    },
  );

  // H3h
  it('rejects an UPSTREAM_MAX_CONCURRENT of 0: it would refuse all upstream work', () => {
    expect(() => loadConfig({ DATABASE_URL, UPSTREAM_MAX_CONCURRENT: '0' })).toThrow(
      /UPSTREAM_MAX_CONCURRENT must be greater than 0/,
    );
  });

  it.each(['', '-1', '1.5', 'abc'])(
    'rejects UPSTREAM_MAX_CONCURRENT=%j instead of coercing it',
    (value) => {
      expect(() => loadConfig({ DATABASE_URL, UPSTREAM_MAX_CONCURRENT: value })).toThrow(
        /UPSTREAM_MAX_CONCURRENT must be a non-negative integer/,
      );
    },
  );

  // H4a
  it('rejects a DB_POOL_MAX of 0: a pool needs at least one connection', () => {
    expect(() => loadConfig({ DATABASE_URL, DB_POOL_MAX: '0' })).toThrow(
      /DB_POOL_MAX must be greater than 0/,
    );
  });

  it.each(['', '-1', '1.5', 'abc'])('rejects DB_POOL_MAX=%j instead of coercing it', (value) => {
    expect(() => loadConfig({ DATABASE_URL, DB_POOL_MAX: value })).toThrow(
      /DB_POOL_MAX must be a non-negative integer/,
    );
  });

  it('rejects a port out of range', () => {
    expect(() => loadConfig({ DATABASE_URL, PORT: '70000' })).toThrow(/PORT must be a valid port/);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/);
  });

  it('rejects a DATABASE_URL that is not a postgres URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/ranker' })).toThrow(
      /DATABASE_URL must be a postgres:\/\/ URL/,
    );
  });

  it('rejects a base URL that is not http(s)', () => {
    expect(() => loadConfig({ DATABASE_URL, FORECAST_BASE_URL: 'ftp://example.com' })).toThrow(
      /FORECAST_BASE_URL must be an http\(s\) URL/,
    );
  });

  it('reports every invalid variable at once', () => {
    expect(() => loadConfig({ DATABASE_URL, PORT: 'x', MARINE_RETRY_SECONDS: '-5' })).toThrow(
      /PORT .*; MARINE_RETRY_SECONDS /,
    );
  });

  it('never echoes values back in the error message', () => {
    const leaky = 'mysql://ranker:secret-password@localhost/ranker';
    expect(() => loadConfig({ DATABASE_URL: leaky })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-password') }),
    );
  });
});
