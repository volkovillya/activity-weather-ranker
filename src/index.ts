import { startStandaloneServer } from '@apollo/server/standalone';
import pino from 'pino';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createGraphQLServer } from './graphql/server';
import { createOpenMeteoClient } from './openmeteo/client';
import { createForecastService } from './services/forecastService';
import { createLocationService } from './services/locationService';

async function main(): Promise<void> {
  try {
    process.loadEnvFile(); // a local .env, when there is one
  } catch {
    // No .env file: configuration comes from the environment.
  }
  const config = loadConfig();
  const logger = pino({ name: 'activity-weather-ranker' });

  const { db, pool } = createDb({
    databaseUrl: config.databaseUrl,
    connectionTimeoutMs: config.dbConnectionTimeoutMs,
    statementTimeoutMs: config.dbStatementTimeoutMs,
  });
  const openMeteo = createOpenMeteoClient({
    ...config.openMeteo,
    timeoutMs: config.upstreamTimeoutMs,
  });

  const server = createGraphQLServer({
    logger,
    locationService: createLocationService({
      db,
      geocode: (query) => openMeteo.geocode(query),
      logger,
    }),
    forecastService: createForecastService({
      db,
      client: openMeteo,
      clock: () => new Date(),
      forecastTtlSeconds: config.forecastTtlSeconds,
      marineRetrySeconds: config.marineRetrySeconds,
      logger,
    }),
  });

  const { url } = await startStandaloneServer(server, { listen: { port: config.port } });
  logger.info({ url }, 'server.started');

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'server.stopping');
    void server
      .stop()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'server.stop_failed');
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Config errors never contain secret values (see loadConfig).
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
