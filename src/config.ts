import { z } from 'zod';

// Environment variables are strings. Only plain digit strings are accepted, so values such as
// "", "-1", "1.5" or " 60" are rejected instead of being coerced into a surprising number.
const nonNegativeInt = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer')
  .transform(Number);

const positiveInt = nonNegativeInt.refine((n) => n > 0, 'must be greater than 0');

const httpUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' });

const EnvSchema = z.object({
  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: (issue) => (issue.input === undefined ? 'is required' : 'must be a postgres:// URL'),
  }),
  PORT: positiveInt.refine((n) => n <= 65535, 'must be a valid port').default(4000),
  FORECAST_TTL_SECONDS: nonNegativeInt.default(3600),
  MARINE_RETRY_SECONDS: nonNegativeInt.default(300),
  UPSTREAM_TIMEOUT_MS: positiveInt.default(3000),
  GEOCODING_BASE_URL: httpUrl.default('https://geocoding-api.open-meteo.com'),
  FORECAST_BASE_URL: httpUrl.default('https://api.open-meteo.com'),
  MARINE_BASE_URL: httpUrl.default('https://marine-api.open-meteo.com'),
});

export interface Config {
  databaseUrl: string;
  port: number;
  forecastTtlSeconds: number;
  marineRetrySeconds: number;
  upstreamTimeoutMs: number;
  openMeteo: {
    geocodingBaseUrl: string;
    forecastBaseUrl: string;
    marineBaseUrl: string;
  };
}

/**
 * Reads and validates configuration from environment variables.
 * Throws one error listing every invalid variable. Values are never echoed back,
 * so a malformed DATABASE_URL cannot leak its password into logs.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')} ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    forecastTtlSeconds: e.FORECAST_TTL_SECONDS,
    marineRetrySeconds: e.MARINE_RETRY_SECONDS,
    upstreamTimeoutMs: e.UPSTREAM_TIMEOUT_MS,
    openMeteo: {
      geocodingBaseUrl: e.GEOCODING_BASE_URL,
      forecastBaseUrl: e.FORECAST_BASE_URL,
      marineBaseUrl: e.MARINE_BASE_URL,
    },
  };
}
