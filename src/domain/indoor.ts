import { outdoorModel } from './outdoor';
import { precipitationMm, precipitationNote, windKmh, windNote } from './readings';
import { evaluateGates, roundScore, scoreActivity, type Measure } from './scoreActivity';
import type { ActivityScorer, DailyWeather } from './types';

/** Indoor sightseeing is always possible, but getting there in a storm is not pleasant. */
const travelGates: readonly Measure[] = [
  {
    curve: [
      [60, 1],
      [100, 0.2],
    ],
    value: windKmh,
    note: windNote,
  },
  {
    curve: [
      [30, 1],
      [80, 0.3],
    ],
    value: precipitationMm,
    note: precipitationNote,
  },
];

/**
 * "How good a choice is indoor sightseeing today": 50 on a perfect outdoor day, rising to 100
 * as the outdoor score falls, capped when the weather makes travel unsafe. Range 10–100.
 */
function scoreIndoor(day: DailyWeather) {
  const outdoorScore = scoreActivity(outdoorModel, day).score;
  const { gate, limitedBy } = evaluateGates(travelGates, day);
  return {
    score: roundScore(gate * (50 + (100 - outdoorScore) / 2)),
    gate,
    quality: null,
    reasons: [...limitedBy, `outdoor score ${outdoorScore}`],
  };
}

export const indoorSightseeing: ActivityScorer = {
  activity: 'INDOOR_SIGHTSEEING',
  // It reads everything outdoor sightseeing reads, because it is derived from that score.
  inputs: outdoorModel.inputs,
  score: scoreIndoor,
};
