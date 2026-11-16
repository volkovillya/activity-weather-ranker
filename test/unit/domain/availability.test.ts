import { describe, expect, it } from '@jest/globals';
import { checkAvailability } from '../../../src/domain/availability';
import { indoorSightseeing } from '../../../src/domain/indoor';
import { outdoorSightseeing } from '../../../src/domain/outdoor';
import { rankActivities } from '../../../src/domain/rank';
import { skiing } from '../../../src/domain/skiing';
import { surfing } from '../../../src/domain/surfing';
import type { DailyWeather, WeatherField } from '../../../src/domain/types';
import { makeDay, makeWeek } from './makeDay';

const ALL_FIELDS: WeatherField[] = [
  'tempMaxC',
  'precipitationMm',
  'snowfallCm',
  'snowDepthM',
  'windSpeedMaxKmh',
  'sunshineS',
  'daylightS',
  'waveHeightMaxM',
  'swellPeriodMaxS',
];
const SCORERS = [skiing, surfing, outdoorSightseeing, indoorSightseeing];

const fullWeek = () => makeWeek(Array.from({ length: 7 }, () => ({})));

/** Applies `overrides` to the days at the given indexes of a complete week. */
function weekWith(overrides: Partial<DailyWeather>, dayIndexes = [0, 1, 2, 3, 4, 5, 6]) {
  return fullWeek().map((day, i) => (dayIndexes.includes(i) ? { ...day, ...overrides } : day));
}

function reasonsByActivity(week: DailyWeather[]) {
  return Object.fromEntries(rankActivities(week).map((r) => [r.activity, r.unavailableReason]));
}

// The availability rules trust each activity's `inputs` list, so the list must match what is read.
describe('declared inputs', () => {
  it.each(SCORERS.map((s) => [s.activity, s] as const))(
    '%s scores a day on which every undeclared field is null',
    (_, scorer) => {
      const nulls = Object.fromEntries(
        ALL_FIELDS.filter((f) => !scorer.inputs.includes(f)).map((f) => [f, null]),
      );
      expect(() => scorer.score(makeDay(nulls))).not.toThrow();
    },
  );

  it.each(SCORERS.flatMap((s) => s.inputs.map((field) => [s.activity, field, s] as const)))(
    '%s really reads its declared input %s',
    (_, field, scorer) => {
      expect(() => scorer.score(makeDay({ [field]: null }))).toThrow(field);
    },
  );
});

// Domain invariant: every value that reaches scoring is finite. Upstream validation (the
// Open-Meteo client) is responsible for rejecting such data; scoring refuses to hide it.
describe('non-finite inputs', () => {
  it.each(
    SCORERS.flatMap((s) =>
      s.inputs.flatMap((field) =>
        [NaN, Infinity, -Infinity].map((value) => [s.activity, field, value, s] as const),
      ),
    ),
  )('%s refuses %s = %p instead of scoring it', (_, field, value, scorer) => {
    expect(() => scorer.score(makeDay({ [field]: value }))).toThrow(
      `${field} is not a finite number`,
    );
  });
});

// S6
describe('availability', () => {
  it('makes every activity available on a complete week, with 7 days and no reason', () => {
    for (const ranking of rankActivities(fullWeek())) {
      expect(ranking.available).toBe(true);
      expect(ranking.unavailableReason).toBeNull();
      expect(ranking.days).toHaveLength(7);
    }
  });

  it('reports INCOMPLETE_DATA for exactly the activities that read a missing weather input', () => {
    expect(reasonsByActivity(weekWith({ snowDepthM: null }, [3]))).toEqual({
      SKIING: 'INCOMPLETE_DATA',
      SURFING: null,
      OUTDOOR_SIGHTSEEING: null,
      INDOOR_SIGHTSEEING: null,
    });
    expect(reasonsByActivity(weekWith({ sunshineS: null }, [6]))).toEqual({
      SKIING: null,
      SURFING: null,
      OUTDOOR_SIGHTSEEING: 'INCOMPLETE_DATA',
      INDOOR_SIGHTSEEING: 'INCOMPLETE_DATA',
    });
    expect(reasonsByActivity(weekWith({ windSpeedMaxKmh: null }, [0]))).toEqual({
      SKIING: 'INCOMPLETE_DATA',
      SURFING: 'INCOMPLETE_DATA',
      OUTDOOR_SIGHTSEEING: 'INCOMPLETE_DATA',
      INDOOR_SIGHTSEEING: 'INCOMPLETE_DATA',
    });
  });

  it('reports NO_MARINE_DATA when the marine request succeeded but returned no waves (inland)', () => {
    const inland = weekWith({ waveHeightMaxM: null, swellPeriodMaxS: null, marineFetched: true });
    expect(checkAvailability(surfing, inland)).toBe('NO_MARINE_DATA');
  });

  it('reports MARINE_TEMPORARILY_UNAVAILABLE when the marine request failed', () => {
    const failed = weekWith({ waveHeightMaxM: null, swellPeriodMaxS: null, marineFetched: false });
    expect(checkAvailability(surfing, failed)).toBe('MARINE_TEMPORARILY_UNAVAILABLE');
  });

  it('checks the marine flag before the values: one failed day hides a week of good wave data', () => {
    const week = weekWith({ marineFetched: false }, [4]);
    expect(week.every((d) => d.waveHeightMaxM !== null && d.swellPeriodMaxS !== null)).toBe(true);
    expect(checkAvailability(surfing, week)).toBe('MARINE_TEMPORARILY_UNAVAILABLE');
  });

  it('reports INCOMPLETE_DATA when marine data is missing on only some days', () => {
    expect(checkAvailability(surfing, weekWith({ swellPeriodMaxS: null }, [2]))).toBe(
      'INCOMPLETE_DATA',
    );
    expect(checkAvailability(surfing, weekWith({ waveHeightMaxM: null }, [0, 1, 2, 3, 4, 5]))).toBe(
      'INCOMPLETE_DATA',
    );
  });

  it('never applies the marine rules to activities that do not read marine data', () => {
    const failedMarine = weekWith({
      waveHeightMaxM: null,
      swellPeriodMaxS: null,
      marineFetched: false,
    });
    for (const scorer of [skiing, outdoorSightseeing, indoorSightseeing]) {
      expect(checkAvailability(scorer, failedMarine)).toBeNull();
    }
  });
});
