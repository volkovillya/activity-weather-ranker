import { rankActivities } from '../domain/rank';
import type { ForecastService } from '../services/forecastService';
import type { LocationService } from '../services/locationService';
import { badUserInput, toClientError } from './errors';

export interface ResolverDeps {
  locationService: Pick<LocationService, 'resolveLocation'>;
  forecastService: Pick<ForecastService, 'getWeek'>;
}

const MAX_CITY_LENGTH = 100;

/** Trimmed; 1–100 characters (counted as Unicode code points, not UTF-16 units). */
function validateCity(city: string): string {
  const trimmed = city.trim();
  if (trimmed.length === 0) throw badUserInput('city must not be empty');
  if ([...trimmed].length > MAX_CITY_LENGTH) {
    throw badUserInput(`city must be at most ${MAX_CITY_LENGTH} characters`);
  }
  return trimmed;
}

export function createResolvers({ locationService, forecastService }: ResolverDeps) {
  return {
    Query: {
      async activityRankings(_parent: unknown, args: { city: string }) {
        const city = validateCity(args.city);
        try {
          const location = await locationService.resolveLocation(city);
          const week = await forecastService.getWeek(location);
          return {
            location: { ...location, id: String(location.id) },
            fetchedAt: week.fetchedAt.toISOString(),
            stale: week.stale,
            activities: rankActivities(week.days),
          };
        } catch (error) {
          throw toClientError(error);
        }
      },
    },
  };
}
