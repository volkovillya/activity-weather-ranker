import { checkAvailability } from './availability';
import { indoorSightseeing } from './indoor';
import { outdoorSightseeing } from './outdoor';
import { skiing } from './skiing';
import { surfing } from './surfing';
import type { ActivityRanking, ActivityScorer, DailyWeather } from './types';

/** In the order of ACTIVITIES, which is the order the API returns. */
const SCORERS: readonly ActivityScorer[] = [skiing, surfing, outdoorSightseeing, indoorSightseeing];

/**
 * Rank per position: 1 + the number of strictly higher scores, so equal scores share a rank
 * and the next rank is skipped (90, 80, 90 → 1, 3, 1).
 */
export function assignRanks(scores: readonly number[]): number[] {
  return scores.map((score) => 1 + scores.filter((other) => other > score).length);
}

/**
 * Turns a week of stored weather (chronological) into the four activity rankings.
 * Days keep the order they were given in; each carries its score, rank and reasons.
 * The caller supplies a complete week (the forecast service never serves a partial one);
 * an empty week is rejected because every availability rule would be vacuously true.
 */
export function rankActivities(week: readonly DailyWeather[]): ActivityRanking[] {
  if (week.length === 0) throw new Error('rankActivities needs at least one day');

  return SCORERS.map((scorer) => {
    const reason = checkAvailability(scorer, week);
    if (reason !== null) {
      return { activity: scorer.activity, available: false, unavailableReason: reason, days: [] };
    }

    const scored = week.map((day) => ({ date: day.date, ...scorer.score(day) }));
    const ranks = assignRanks(scored.map((s) => s.score));
    return {
      activity: scorer.activity,
      available: true,
      unavailableReason: null,
      days: scored.map((s, i) => ({
        date: s.date,
        score: s.score,
        rank: ranks[i]!,
        reasons: s.reasons,
      })),
    };
  });
}
