/** The geocoder answered and knows no such place. Maps to LOCATION_NOT_FOUND. */
export class LocationNotFoundError extends Error {
  override readonly name = 'LocationNotFoundError';

  constructor(readonly query: string) {
    super(`No location found for "${query}"`);
  }
}

/**
 * Open-Meteo could not be reached or answered badly, and there is nothing stored to fall back
 * on. Maps to UPSTREAM_UNAVAILABLE.
 */
export class UpstreamUnavailableError extends Error {
  override readonly name = 'UpstreamUnavailableError';
}
