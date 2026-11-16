import { ApolloServer } from '@apollo/server';
import { GraphQLError, Kind, type SelectionSetNode, type ValidationRule } from 'graphql';
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

/** Each city can cost up to three Open-Meteo calls, so one operation may ask for only this many. */
export const MAX_CITIES_PER_OPERATION = 1;

/**
 * Rejects an operation that requests more than MAX_CITIES_PER_OPERATION cities. Root query fields
 * run concurrently, so aliases would otherwise turn one request into hundreds of upstream calls.
 * Counts distinct response keys of `activityRankings`, following fragment spreads and inline
 * fragments. Fields with the same key are merged by GraphQL and resolved once. Directives such
 * as `@skip` are ignored, so the count can only be too high, never too low.
 */
const limitCitiesPerOperation: ValidationRule = (context) => ({
  OperationDefinition(operation) {
    const responseKeys = new Set<string>();
    const visitedFragments = new Set<string>();

    const collect = (selectionSet: SelectionSetNode): void => {
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          if (selection.name.value === 'activityRankings') {
            responseKeys.add(selection.alias?.value ?? selection.name.value);
          }
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          collect(selection.selectionSet);
        } else if (!visitedFragments.has(selection.name.value)) {
          // A fragment is followed once, so a cycle (reported by the standard rules) cannot loop.
          visitedFragments.add(selection.name.value);
          const fragment = context.getFragment(selection.name.value);
          if (fragment) collect(fragment.selectionSet);
        }
      }
    };

    collect(operation.selectionSet);
    if (responseKeys.size > MAX_CITIES_PER_OPERATION) {
      context.reportError(
        new GraphQLError(`An operation may request at most ${MAX_CITIES_PER_OPERATION} city.`, {
          nodes: operation,
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
    validationRules: [knownOperationTypes, limitCitiesPerOperation],
    formatError: createFormatError(deps.logger),
    includeStacktraceInErrorResponses: false,
  });
}
