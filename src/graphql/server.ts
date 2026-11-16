import { ApolloServer } from '@apollo/server';
import { GraphQLError, type ValidationRule } from 'graphql';
import type { Logger } from '../services/logger';
import { createFormatError } from './errors';
import { createResolvers, type ResolverDeps } from './resolvers';
import { typeDefs } from './schema';

/**
 * Rejects operations the schema has no root type for (this API has queries only). graphql-js 16
 * would otherwise fail a mutation at execution time with an unclassified error, which
 * `formatError` would then mask as an internal error. graphql-js 17 ships this same rule as
 * `KnownOperationTypesRule`.
 */
const knownOperationTypes: ValidationRule = (context) => ({
  OperationDefinition(node) {
    if (!context.getSchema().getRootType(node.operation)) {
      context.reportError(
        new GraphQLError(`This API does not support ${node.operation} operations.`, {
          nodes: node,
        }),
      );
    }
  },
});

/** The GraphQL server, without HTTP: `http.ts` serves it, tests call `executeOperation`. */
export function createGraphQLServer(deps: ResolverDeps & { logger: Logger }): ApolloServer {
  return new ApolloServer({
    typeDefs,
    resolvers: createResolvers(deps),
    validationRules: [knownOperationTypes],
    formatError: createFormatError(deps.logger),
    includeStacktraceInErrorResponses: false,
  });
}
