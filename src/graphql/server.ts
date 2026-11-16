import { ApolloServer } from '@apollo/server';
import type { Logger } from '../services/logger';
import { createFormatError } from './errors';
import { createResolvers, type ResolverDeps } from './resolvers';
import { typeDefs } from './schema';

/** The GraphQL server, without HTTP: `index.ts` listens, tests call `executeOperation`. */
export function createGraphQLServer(deps: ResolverDeps & { logger: Logger }): ApolloServer {
  return new ApolloServer({
    typeDefs,
    resolvers: createResolvers(deps),
    formatError: createFormatError(deps.logger),
    includeStacktraceInErrorResponses: false,
  });
}
