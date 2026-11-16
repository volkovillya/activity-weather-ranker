import { formatValue, required, scoreActivity, type ActivityModel } from './scoreActivity';
import type { ActivityScorer, DailyWeather } from './types';

const waveHeightM = (d: DailyWeather) => required(d, 'waveHeightMaxM');
const swellPeriodS = (d: DailyWeather) => required(d, 'swellPeriodMaxS');
const windKmh = (d: DailyWeather) => required(d, 'windSpeedMaxKmh');

const waveHeightNote = (d: DailyWeather) => `wave height ${formatValue(waveHeightM(d))} m`;
const windNote = (d: DailyWeather) => `wind ${formatValue(windKmh(d))} km/h`;

/**
 * Judged from the offshore wave model near the town, for a recreational surfer.
 * Wind direction relative to the coast, tides and water temperature are not considered.
 */
export const surfingModel: ActivityModel = {
  inputs: ['waveHeightMaxM', 'swellPeriodMaxS', 'windSpeedMaxKmh'],
  gates: [
    {
      // Too flat and too big both make surfing impossible.
      curve: [
        [0.3, 0],
        [0.8, 1],
        [2.5, 1],
        [4.5, 0],
      ],
      value: waveHeightM,
      note: waveHeightNote,
    },
    {
      // Strong wind blows the surf out.
      curve: [
        [40, 1],
        [70, 0],
      ],
      value: windKmh,
      note: windNote,
    },
  ],
  factors: [
    {
      // Longer-period swell makes cleaner, more powerful waves; it matters more than height.
      weight: 0.5,
      curve: [
        [5, 0.2],
        [12, 1],
      ],
      value: swellPeriodS,
      note: (d) => `swell period ${formatValue(swellPeriodS(d))} s`,
    },
    {
      weight: 0.25,
      curve: [
        [0.5, 0.4],
        [1.2, 1],
        [2, 1],
        [3.5, 0.4],
      ],
      value: waveHeightM,
      note: waveHeightNote,
    },
    {
      weight: 0.25,
      curve: [
        [10, 1],
        [40, 0.3],
      ],
      value: windKmh,
      note: windNote,
    },
  ],
};

export const surfing: ActivityScorer = {
  activity: 'SURFING',
  inputs: surfingModel.inputs,
  score: (day) => scoreActivity(surfingModel, day),
};
