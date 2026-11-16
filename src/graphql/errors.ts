import { ApolloServerErrorCode, unwrapResolverError } from '@apollo/server/errors';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { LocationNotFoundError, UpstreamUnavailableError } from '../services/errors';
import type { Logger } from '../services/logger';

export const ErrorCode = {
  BAD_USER_INPUT: 'BAD_USER_INPUT',
  LOCATION_NOT_FOUND: 'LOCATION_NOT_FOUND',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
} as const;

/** Errors whose message is written for the client. Everything else is masked. */
const CLIENT_FACING_CODES = new Set<string>([
  ErrorCode.BAD_USER_INPUT,
  ErrorCode.LOCATION_NOT_FOUND,
  ErrorCode.UPSTREAM_UNAVAILABLE,
  // Request errors raised by Apollo itself (malformed query, unknown field, wrong variables).
  ApolloServerErrorCode.GRAPHQL_PARSE_FAILED,
  ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED,
  ApolloServerErrorCode.BAD_REQUEST,
  ApolloServerErrorCode.OPERATION_RESOLUTION_FAILURE,
  ApolloServerErrorCode.PERSISTED_QUERY_NOT_FOUND,
  ApolloServerErrorCode.PERSISTED_QUERY_NOT_SUPPORTED,
]);

export function badUserInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: ErrorCode.BAD_USER_INPUT } });
}

/**
 * Maps the services' known failures to client errors with fixed wording. Upstream details
 * (URLs, HTTP statuses) stay in the logs. Anything else is returned unchanged and masked by
 * `formatError`.
 */
export function toClientError(error: unknown): unknown {
  if (error instanceof LocationNotFoundError) {
    return new GraphQLError(`No location found for "${error.query}"`, {
      extensions: { code: ErrorCode.LOCATION_NOT_FOUND },
    });
  }
  if (error instanceof UpstreamUnavailableError) {
    return new GraphQLError('Weather data is temporarily unavailable. Please try again later.', {
      extensions: { code: ErrorCode.UPSTREAM_UNAVAILABLE },
    });
  }
  return error;
}

/**
 * Last line of defence: only client-facing errors keep their message; every other error,
 * including anything unexpected, becomes a generic INTERNAL_SERVER_ERROR and is logged in full.
 * Stack traces are never included (Apollo's `includeStacktraceInErrorResponses` is off too).
 */
export function createFormatError(logger: Logger) {
  return (formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError => {
    const code = formatted.extensions?.code;
    const { locations, path } = formatted;
    if (typeof code === 'string' && CLIENT_FACING_CODES.has(code)) {
      return { message: formatted.message, locations, path, extensions: { code } };
    }

    const original = unwrapResolverError(error);
    logger.error({ err: original, path }, 'graphql.internal_error');
    return {
      message: 'Internal server error',
      locations,
      path,
      extensions: { code: ErrorCode.INTERNAL_SERVER_ERROR },
    };
  };
}
