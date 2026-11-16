import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApolloServer } from '@apollo/server';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { expressMiddleware } from '@as-integrations/express5';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from '../services/logger';

/**
 * Express's own default. A query for this schema is a few kilobytes; a larger limit only lets
 * a client make the server buffer and synchronously parse a huge body.
 */
const BODY_LIMIT = '100kb';

/**
 * Serves the GraphQL server over HTTP with Apollo's official Express integration: CORS for
 * every origin, a JSON body parser, then Apollo. `server.stop()` also drains and closes the
 * HTTP server.
 */
export async function startHttpServer(
  server: ApolloServer,
  options: { port: number; logger: Logger },
): Promise<{ url: string }> {
  const app = express();
  app.disable('x-powered-by');
  const httpServer = http.createServer(app);

  server.addPlugin(ApolloServerPluginDrainHttpServer({ httpServer }));
  await server.start();

  app.use(cors(), express.json({ limit: BODY_LIMIT }), expressMiddleware(server));
  app.use(requestErrorHandler(options.logger));

  await new Promise<void>((resolve) => httpServer.listen(options.port, resolve));
  const { port } = httpServer.address() as AddressInfo;
  return { url: `http://localhost:${port}/` };
}

/**
 * Answers errors raised before GraphQL runs (body parsing) in the same JSON shape as GraphQL
 * errors, with fixed wording. Express's default handler would send an HTML page that, outside
 * production, contains the stack trace and absolute file paths.
 */
function requestErrorHandler(logger: Logger) {
  // Express recognises an error handler by its four parameters.
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error); // too late to answer: Express closes the connection
      return;
    }

    const { status, type } = describe(error);
    const clientError = status >= 400 && status < 500;
    const message = !clientError
      ? 'Internal server error'
      : type === 'entity.parse.failed'
        ? 'The request body is not valid JSON.'
        : status === 413
          ? 'The request body is too large.'
          : status === 415
            ? 'The request body encoding is not supported.'
            : 'Bad request.';

    if (clientError) logger.warn({ status, type }, 'http.bad_request');
    else logger.error({ err: error }, 'http.internal_error');

    res.status(clientError ? status : 500).json({
      errors: [
        { message, extensions: { code: clientError ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR' } },
      ],
    });
  };
}

/** body-parser errors carry an HTTP `status` and a machine-readable `type`. */
function describe(error: unknown): { status: number; type?: string } {
  if (typeof error !== 'object' || error === null) return { status: 500 };
  const { status, type } = error as { status?: unknown; type?: unknown };
  return {
    status: typeof status === 'number' && status >= 400 && status < 600 ? status : 500,
    type: typeof type === 'string' ? type : undefined,
  };
}
