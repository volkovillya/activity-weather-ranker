import { tempMaxC, tempNote, windKmh, windNote } from './readings';
import { formatValue, required, scoreActivity, type ActivityModel } from './scoreActivity';
import type { ActivityScorer, DailyWeather } from './types';

// Snow depth is stored in metres (as Open-Meteo returns it); the curves below use centimetres.
const snowDepthCm = (d: DailyWeather) => required(d, 'snowDepthM') * 100;
const freshSnowCm = (d: DailyWeather) => required(d, 'snowfallCm');

/** Thresholds and weights are judgment calls for a recreational skier (see docs/DECISIONS.md). */
export const skiingModel: ActivityModel = {
  inputs: ['snowDepthM', 'snowfallCm', 'tempMaxC', 'windSpeedMaxKmh'],
  gates: [
    {
      // No base, no skiing: nothing below 5 cm, fully open from 40 cm.
      curve: [
        [5, 0],
        [40, 1],
      ],
      value: snowDepthCm,
      note: (d) => `snow depth ${formatValue(snowDepthCm(d))} cm`,
    },
    {
      // Lifts start closing in strong wind.
      curve: [
        [50, 1],
        [80, 0],
      ],
      value: windKmh,
      note: windNote,
    },
  ],
  factors: [
    {
      // Fresh snow is a bonus; none is neutral (0.5), not bad.
      weight: 0.3,
      curve: [
        [0, 0.5],
        [10, 1],
      ],
      value: freshSnowCm,
      note: (d) => `fresh snowfall ${formatValue(freshSnowCm(d))} cm`,
    },
    {
      // Cold keeps snow good; thaw makes slush; extreme cold is unpleasant.
      weight: 0.4,
      curve: [
        [-25, 0.3],
        [-12, 1],
        [-1, 1],
        [4, 0.5],
        [10, 0.2],
      ],
      value: tempMaxC,
      note: tempNote,
    },
    {
      weight: 0.3,
      curve: [
        [15, 1],
        [50, 0.3],
      ],
      value: windKmh,
      note: windNote,
    },
  ],
};

export const skiing: ActivityScorer = {
  activity: 'SKIING',
  inputs: skiingModel.inputs,
  score: (day) => scoreActivity(skiingModel, day),
};
