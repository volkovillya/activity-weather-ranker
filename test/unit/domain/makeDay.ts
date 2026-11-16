import type { DailyWeather } from '../../../src/domain/types';

export const DAYLIGHT_S = 36_000;

/**
 * One explicit, unremarkable day. Tests override only the fields they depend on,
 * so every expected number in a test can be traced to values written in that test.
 */
const BASELINE: DailyWeather = {
  date: '2026-11-16',
  marineFetched: true,
  tempMaxC: 15,
  precipitationMm: 0,
  snowfallCm: 0,
  snowDepthM: 0,
  windSpeedMaxKmh: 10,
  sunshineS: 18_000,
  daylightS: DAYLIGHT_S,
  waveHeightMaxM: 1.5,
  swellPeriodMaxS: 12,
};

export function makeDay(overrides: Partial<DailyWeather> = {}): DailyWeather {
  return { ...BASELINE, ...overrides };
}

/** Consecutive days starting 2026-11-16, one override object per day. The date is always generated. */
export function makeWeek(days: Partial<DailyWeather>[]): DailyWeather[] {
  return days.map((overrides, i) => makeDay({ ...overrides, date: `2026-11-${16 + i}` }));
}

/** Skiing inputs in the units the plan's tables use. */
export function skiDay(depthCm: number, freshCm: number, tempC: number, windKmh: number) {
  return makeDay({
    snowDepthM: depthCm / 100,
    snowfallCm: freshCm,
    tempMaxC: tempC,
    windSpeedMaxKmh: windKmh,
  });
}

export function surfDay(heightM: number, periodS: number, windKmh: number) {
  return makeDay({ waveHeightMaxM: heightM, swellPeriodMaxS: periodS, windSpeedMaxKmh: windKmh });
}

/** Sightseeing inputs; `sunShare` is the fraction of daylight with sunshine. */
export function cityDay(
  tempC: number,
  rainMm: number,
  sunShare: number,
  windKmh: number,
  daylightS = DAYLIGHT_S,
) {
  return makeDay({
    tempMaxC: tempC,
    precipitationMm: rainMm,
    sunshineS: sunShare * daylightS,
    daylightS,
    windSpeedMaxKmh: windKmh,
  });
}
