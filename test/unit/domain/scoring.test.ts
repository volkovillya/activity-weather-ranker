import { describe, expect, it } from '@jest/globals';
import { indoorSightseeing } from '../../../src/domain/indoor';
import { outdoorModel, outdoorSightseeing } from '../../../src/domain/outdoor';
import { roundScore, type ActivityModel } from '../../../src/domain/scoreActivity';
import { skiing, skiingModel } from '../../../src/domain/skiing';
import { surfing, surfingModel } from '../../../src/domain/surfing';
import type { ActivityScorer, DailyWeather } from '../../../src/domain/types';
import { cityDay, DAYLIGHT_S, makeDay, skiDay, surfDay } from './makeDay';

type Row = [label: string, day: DailyWeather, gate: number, quality: number | null, score: number];

function expectRow(scorer: ActivityScorer, [, day, gate, quality, score]: Row) {
  const result = scorer.score(day);
  expect(result.score).toBe(score);
  expect(result.gate).toBeCloseTo(gate, 3);
  if (quality === null) expect(result.quality).toBeNull();
  else expect(result.quality).toBeCloseTo(quality, 3);
}

describe('scoring models are well-formed', () => {
  it.each<[string, ActivityModel]>([
    ['skiing', skiingModel],
    ['surfing', surfingModel],
    ['outdoor sightseeing', outdoorModel],
  ])('%s: factor weights sum to 1, curves rise in x and stay within [0, 1]', (_, model) => {
    const weightSum = model.factors.reduce((sum, f) => sum + f.weight, 0);
    expect(weightSum).toBeCloseTo(1, 12);

    for (const { curve } of [...model.gates, ...model.factors]) {
      curve.forEach(([x, y], i) => {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
        if (i > 0) expect(x).toBeGreaterThan(curve[i - 1]![0]);
      });
    }
  });
});

// S1 — the two example tables of the plan, row for row.
describe('expected examples', () => {
  const skiingRows: Row[] = [
    ['80 cm base, 15 cm fresh, -5 °C, wind 10', skiDay(80, 15, -5, 10), 1, 1, 100],
    ['80 cm base, no fresh snow, -3 °C, wind 10', skiDay(80, 0, -3, 10), 1, 0.85, 85],
    ['no snow, otherwise perfect', skiDay(0, 0, -3, 10), 0, 0.85, 0],
    ['20 cm base, 5 cm fresh, 1 °C, wind 25', skiDay(20, 5, 1, 25), 0.429, 0.785, 34],
    ['100 cm base, no fresh, 9 °C, wind 15 (slush)', skiDay(100, 0, 9, 15), 1, 0.55, 55],
    ['100 cm base, wind 80 (lifts closed)', skiDay(100, 40, -8, 80), 0, 0.79, 0],
    ['boundary: base 5 cm', skiDay(5, 15, -5, 10), 0, 1, 0],
    ['boundary: base 22.5 cm', skiDay(22.5, 15, -5, 10), 0.5, 1, 50],
    ['boundary: base 40 cm', skiDay(40, 15, -5, 10), 1, 1, 100],
    ['boundary: wind 50', skiDay(80, 15, -5, 50), 1, 0.79, 79],
    ['boundary: wind 65 — exact half 39.5 rounds up', skiDay(80, 15, -5, 65), 0.5, 0.79, 40],
  ];
  const surfingRows: Row[] = [
    ['1.5 m, 13 s, wind 8', surfDay(1.5, 13, 8), 1, 1, 100],
    ['0.2 m (flat)', surfDay(0.2, 10, 5), 0, 0.736, 0],
    ['1.2 m, 6 s, wind 30 (wind chop)', surfDay(1.2, 6, 30), 1, 0.54, 54],
    ['3.5 m, 14 s, wind 15 (big)', surfDay(3.5, 14, 15), 0.5, 0.821, 41],
    ['5 m (too big)', surfDay(5, 15, 10), 0, 0.85, 0],
    ['boundary: 0.3 m', surfDay(0.3, 13, 8), 0, 0.85, 0],
    ['boundary: 0.8 m', surfDay(0.8, 13, 8), 1, 0.914, 91],
    ['boundary: 2.5 m', surfDay(2.5, 13, 8), 1, 0.95, 95],
    ['boundary: 4.5 m', surfDay(4.5, 13, 8), 0, 0.85, 0],
  ];
  const outdoorRows: Row[] = [
    ['22 °C, dry, 80% sun, wind 8', cityDay(22, 0, 0.8, 8), 1, 1, 100],
    ['16 °C, dry, 5% sun, wind 12', cityDay(16, 0, 0.05, 12), 1, 0.767, 77],
    ['22 °C, 25 mm rain, no sun, wind 10', cityDay(22, 25, 0, 10), 0.3, 0.79, 24],
    ['40 °C, sunny, wind 10', cityDay(40, 0, 0.9, 10), 0.222, 0.7, 16],
    ['-15 °C, polar night, wind 20', cityDay(-15, 0, 0, 20, 0), 0.333, 0.367, 12],
    ['12 °C, 40 mm rain, wind 90 (storm)', cityDay(12, 40, 0, 90), 0, 0.535, 0],
    ['boundary: 1 mm rain', cityDay(22, 1, 0.8, 8), 1, 1, 100],
    ['boundary: 10 mm rain', cityDay(22, 10, 0.8, 8), 0.6, 1, 60],
    ['boundary: -5 °C', cityDay(-5, 0, 0.8, 8), 1, 0.6, 60],
    ['boundary: 33 °C', cityDay(33, 0, 0.8, 8), 1, 0.7, 70],
  ];
  const indoorRows: Row[] = [
    ['perfect outdoor day (outdoor 100)', cityDay(22, 0, 0.8, 8), 1, null, 50],
    ['downpour day (outdoor 24)', cityDay(22, 25, 0, 10), 1, null, 88],
    ['storm day (outdoor 0, wind 90, 40 mm)', cityDay(12, 40, 0, 90), 0.4, null, 40],
    ['outdoor 77 — 61.5 rounds up', cityDay(16, 0, 0.05, 12), 1, null, 62],
  ];

  it('has all 34 rows', () => {
    expect(skiingRows.length + surfingRows.length + outdoorRows.length + indoorRows.length).toBe(
      34,
    );
  });

  it.each(skiingRows)('skiing: %s', (...row) => expectRow(skiing, row));
  it.each(surfingRows)('surfing: %s', (...row) => expectRow(surfing, row));
  it.each(outdoorRows)('outdoor sightseeing: %s', (...row) => expectRow(outdoorSightseeing, row));
  it.each(indoorRows)('indoor sightseeing: %s', (...row) => expectRow(indoorSightseeing, row));
});

describe('roundScore', () => {
  it('rounds exact halves up even when floating point lands just below them', () => {
    const justBelowHalf = 39.49999999999999; // what 100 × 0.5 × 0.79 evaluates to
    expect(Math.round(justBelowHalf)).toBe(39);
    expect(roundScore(justBelowHalf)).toBe(40);
    expect(roundScore(61.5)).toBe(62);
    expect(roundScore(33.64)).toBe(34);
    expect(roundScore(33.4)).toBe(33);
  });
});

// S2
describe('bounds', () => {
  const scorers = [skiing, surfing, outdoorSightseeing, indoorSightseeing];
  const extremes = {
    tempMaxC: [-60, -20, 0, 25, 60],
    precipitationMm: [0, 200, 1000],
    windSpeedMaxKmh: [0, 150, 400],
    snowDepthM: [0, 10],
    snowfallCm: [0, 300],
    waveHeightMaxM: [0, 30],
    swellPeriodMaxS: [0, 30],
    daylight: [
      { sunshineS: 0, daylightS: 0 },
      { sunshineS: 90_000, daylightS: DAYLIGHT_S }, // sunshine above daylight: share > 1
    ],
  };

  it('gives an integer score from 0 to 100 for extreme inputs', () => {
    let checked = 0;
    for (const tempMaxC of extremes.tempMaxC)
      for (const precipitationMm of extremes.precipitationMm)
        for (const windSpeedMaxKmh of extremes.windSpeedMaxKmh)
          for (const snowDepthM of extremes.snowDepthM)
            for (const snowfallCm of extremes.snowfallCm)
              for (const waveHeightMaxM of extremes.waveHeightMaxM)
                for (const swellPeriodMaxS of extremes.swellPeriodMaxS)
                  for (const light of extremes.daylight) {
                    const day = makeDay({
                      tempMaxC,
                      precipitationMm,
                      windSpeedMaxKmh,
                      snowDepthM,
                      snowfallCm,
                      waveHeightMaxM,
                      swellPeriodMaxS,
                      ...light,
                    });
                    for (const scorer of scorers) {
                      const { score } = scorer.score(day);
                      expect(Number.isInteger(score)).toBe(true);
                      expect(score).toBeGreaterThanOrEqual(0);
                      expect(score).toBeLessThanOrEqual(100);
                      checked++;
                    }
                  }
    expect(checked).toBe(5 * 3 * 3 * 2 * 2 * 2 * 2 * 2 * 4);
  });

  it('gives a finite score in polar night (zero daylight)', () => {
    const polarNight = cityDay(-15, 0, 0, 20, 0);
    expect(Number.isFinite(outdoorSightseeing.score(polarNight).score)).toBe(true);
    expect(Number.isFinite(indoorSightseeing.score(polarNight).score)).toBe(true);
  });
});

// S3
describe('skiing and snow depth', () => {
  const depthsCm = [0, 5, 10, 20, 22.5, 40, 80, 200];
  const otherInputs: [freshCm: number, tempC: number, windKmh: number][] = [
    [0, -5, 10],
    [10, 2, 30],
    [5, -15, 60],
    [0, 9, 75],
    [40, -30, 0],
  ];

  it.each(otherInputs)(
    'with fresh %p cm, %p °C and wind %p km/h fixed, more snow never lowers the score',
    (freshCm, tempC, windKmh) => {
      const scores = depthsCm.map((cm) => skiing.score(skiDay(cm, freshCm, tempC, windKmh)).score);
      scores.slice(1).forEach((score, i) => expect(score).toBeGreaterThanOrEqual(scores[i]!));
    },
  );

  it('keeps days apart when the snow base is the same all week', () => {
    const week: [freshCm: number, tempC: number, windKmh: number][] = [
      [0, -6, 10],
      [5, -2, 20],
      [0, 2, 35],
      [12, -9, 15],
      [0, 6, 10],
      [2, -1, 45],
      [8, -4, 25],
    ];
    const scores = week.map(
      ([fresh, temp, wind]) => skiing.score(skiDay(20, fresh, temp, wind)).score,
    );
    expect(scores).toEqual([36, 38, 26, 43, 26, 30, 39]);
  });
});

// S4
describe('indoor sightseeing', () => {
  it('does not make a storm day the best indoor day', () => {
    const downpour = indoorSightseeing.score(cityDay(22, 25, 0, 10)).score;
    const storm = indoorSightseeing.score(cityDay(12, 40, 0, 90)).score;
    expect(storm).toBeLessThan(downpour);
  });

  it('rises as the outdoor score falls when travel is safe', () => {
    const days = [
      cityDay(22, 0, 0.8, 8), // outdoor 100
      cityDay(16, 0, 0.05, 12), // outdoor 77
      cityDay(0, 0, 0.7, 10), // outdoor 68
      cityDay(22, 25, 0, 10), // outdoor 24
      cityDay(40, 0, 0.9, 10), // outdoor 16
    ];
    const outdoor = days.map((d) => outdoorSightseeing.score(d).score);
    const indoor = days.map((d) => indoorSightseeing.score(d).score);

    expect(outdoor).toEqual([100, 77, 68, 24, 16]);
    expect(indoor).toEqual([50, 62, 66, 88, 92]);
  });
});

// S7
describe('reasons', () => {
  it('lists limiting gates first, then every factor in table order', () => {
    expect(skiing.score(skiDay(20, 5, 1, 25)).reasons).toEqual([
      'Limited by snow depth 20 cm',
      'fresh snowfall 5 cm',
      'max temperature 1 °C',
      'wind 25 km/h',
    ]);
  });

  it('lists several limiting gates in table order', () => {
    expect(skiing.score(skiDay(20, 0, -5, 65)).reasons).toEqual([
      'Limited by snow depth 20 cm',
      'Limited by wind 65 km/h',
      'fresh snowfall 0 cm',
      'max temperature -5 °C',
      'wind 65 km/h',
    ]);
  });

  it('has no "Limited by" entry when every gate is fully open', () => {
    expect(outdoorSightseeing.score(cityDay(22, 0, 0.8, 8)).reasons).toEqual([
      'max temperature 22 °C',
      'sunshine 80% of daylight',
      'wind 8 km/h',
    ]);
  });

  it('says "no daylight" in polar night', () => {
    expect(outdoorSightseeing.score(cityDay(-15, 0, 0, 20, 0)).reasons).toEqual([
      'Limited by max temperature -15 °C',
      'max temperature -15 °C',
      'no daylight',
      'wind 20 km/h',
    ]);
  });

  it('formats values with at most one decimal', () => {
    expect(surfing.score(surfDay(0.25, 9.87, 12.04)).reasons).toEqual([
      'Limited by wave height 0.3 m',
      'swell period 9.9 s',
      'wave height 0.3 m',
      'wind 12 km/h',
    ]);
  });

  it('explains indoor scores with travel limits and the outdoor score', () => {
    expect(indoorSightseeing.score(cityDay(12, 40, 0, 90)).reasons).toEqual([
      'Limited by wind 90 km/h',
      'Limited by precipitation 40 mm',
      'outdoor score 0',
    ]);
    expect(indoorSightseeing.score(cityDay(22, 25, 0, 10)).reasons).toEqual(['outdoor score 24']);
  });
});
