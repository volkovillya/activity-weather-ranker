import {
  boolean,
  date,
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** A place resolved by Open-Meteo geocoding. Its id is Open-Meteo's, which is stable. */
export const locations = pgTable('locations', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  country: text('country'),
  admin1: text('admin1'),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  timezone: text('timezone').notNull(),
});

/** Normalised search text → location, so the same search never geocodes twice. */
export const locationLookups = pgTable('location_lookups', {
  queryNormalized: text('query_normalized').primaryKey(),
  locationId: integer('location_id')
    .notNull()
    .references(() => locations.id),
});

/**
 * Raw daily weather for one location-local date. Scores are computed on read, so changing a
 * scoring rule never needs a refetch. Measurements are nullable because Open-Meteo can return
 * null; `double precision` keeps upstream numbers exactly as received.
 */
export const dailyForecasts = pgTable(
  'daily_forecasts',
  {
    locationId: integer('location_id')
      .notNull()
      .references(() => locations.id),
    // Read and written as 'YYYY-MM-DD' strings: a JS Date would shift by a day east of UTC.
    date: date('date', { mode: 'string' }).notNull(),
    // When the refresh that wrote this row was requested (not when it finished).
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull(),
    // False when that refresh's marine request failed (as opposed to returning no data inland).
    marineFetched: boolean('marine_fetched').notNull(),
    tempMaxC: doublePrecision('temp_max_c'),
    precipitationMm: doublePrecision('precipitation_mm'),
    snowfallCm: doublePrecision('snowfall_cm'),
    snowDepthM: doublePrecision('snow_depth_m'),
    windSpeedMaxKmh: doublePrecision('wind_speed_max_kmh'),
    sunshineS: doublePrecision('sunshine_s'),
    daylightS: doublePrecision('daylight_s'),
    waveHeightMaxM: doublePrecision('wave_height_max_m'),
    swellPeriodMaxS: doublePrecision('swell_period_max_s'),
  },
  (table) => [primaryKey({ columns: [table.locationId, table.date] })],
);
