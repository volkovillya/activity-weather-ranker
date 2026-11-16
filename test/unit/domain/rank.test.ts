import { describe, expect, it } from '@jest/globals';
import { assignRanks, rankActivities } from '../../../src/domain/rank';
import { ACTIVITIES } from '../../../src/domain/types';
import { cityDay, makeWeek, skiDay } from './makeDay';

// S5
describe('assignRanks', () => {
  it('ranks higher scores first and lets ties share a rank (1, 1, 3)', () => {
    expect(assignRanks([90, 80, 90, 70])).toEqual([1, 3, 1, 4]);
  });

  it('gives every day rank 1 when all scores are equal', () => {
    expect(assignRanks([50, 50, 50])).toEqual([1, 1, 1]);
  });

  it('keeps the input order (ranks are returned per position, not sorted)', () => {
    expect(assignRanks([10, 20, 30, 40, 50, 60, 70])).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });
});

describe('rankActivities', () => {
  const week = makeWeek([
    skiDay(80, 15, -5, 10),
    skiDay(20, 5, 1, 25),
    skiDay(0, 0, -3, 10),
    skiDay(100, 0, 9, 15),
    skiDay(80, 0, -3, 10),
    skiDay(100, 40, -8, 80),
    skiDay(80, 15, -5, 65),
  ]);

  it('returns the four activities in enum order', () => {
    expect(rankActivities(week).map((r) => r.activity)).toEqual([...ACTIVITIES]);
  });

  it('rejects an empty week instead of returning contradictory availability', () => {
    expect(() => rankActivities([])).toThrow('at least one day');
  });

  it('returns the days in input (chronological) order with a rank and the score', () => {
    const skiing = rankActivities(week)[0]!;

    expect(skiing.available).toBe(true);
    expect(skiing.unavailableReason).toBeNull();
    expect(skiing.days.map((d) => d.date)).toEqual(week.map((d) => d.date));
    expect(skiing.days.map((d) => d.score)).toEqual([100, 34, 0, 55, 85, 0, 40]);
    expect(skiing.days.map((d) => d.rank)).toEqual([1, 5, 6, 3, 2, 6, 4]);
  });

  it('marks an activity unavailable with a reason and no days', () => {
    const inland = makeWeek(
      Array.from({ length: 7 }, () => ({
        ...cityDay(20, 0, 0.5, 10),
        waveHeightMaxM: null,
        swellPeriodMaxS: null,
      })),
    );
    const surfing = rankActivities(inland)[1]!;

    expect(surfing).toEqual({
      activity: 'SURFING',
      available: false,
      unavailableReason: 'NO_MARINE_DATA',
      days: [],
    });
  });
});
