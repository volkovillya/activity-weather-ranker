import { formatValue, required, scoreActivity, type ActivityModel } from './scoreActivity';
import type { ActivityScorer, DailyWeather } from './types';

const tempC = (d: DailyWeather) => required(d, 'tempMaxC');
const precipitationMm = (d: DailyWeather) => required(d, 'precipitationMm');
const windKmh = (d: DailyWeather) => required(d, 'windSpeedMaxKmh');

/** Share of daylight with sunshine, 0–1. Zero daylight (polar night) counts as no sunshine. */
function sunshineShare(d: DailyWeather): number {
  const sunshine = required(d, 'sunshineS');
  const daylight = required(d, 'daylightS');
  return daylight > 0 ? Math.min(1, sunshine / daylight) : 0;
}

const tempNote = (d: DailyWeather) => `max temperature ${formatValue(tempC(d))} °C`;
const windNote = (d: DailyWeather) => `wind ${formatValue(windKmh(d))} km/h`;

export const outdoorModel: ActivityModel = {
  inputs: ['tempMaxC', 'precipitationMm', 'sunshineS', 'daylightS', 'windSpeedMaxKmh'],
  gates: [
    {
      // Rain is the main reason to stay in; a drizzle barely matters, a downpour rules it out.
      curve: [
        [1, 1],
        [10, 0.6],
        [30, 0.2],
        [60, 0],
      ],
      value: precipitationMm,
      note: (d) => `precipitation ${formatValue(precipitationMm(d))} mm`,
    },
    {
      // Dangerous cold or heat.
      curve: [
        [-20, 0],
        [-5, 1],
        [33, 1],
        [42, 0],
      ],
      value: tempC,
      note: tempNote,
    },
    {
      curve: [
        [45, 1],
        [80, 0],
      ],
      value: windKmh,
      note: windNote,
    },
  ],
  factors: [
    {
      weight: 0.5,
      curve: [
        [-5, 0.2],
        [5, 0.5],
        [18, 1],
        [26, 1],
        [33, 0.4],
      ],
      value: tempC,
      note: tempNote,
    },
    {
      weight: 0.3,
      curve: [
        [0, 0.3],
        [0.7, 1],
      ],
      value: sunshineShare,
      note: (d) =>
        required(d, 'daylightS') > 0
          ? `sunshine ${Math.round(sunshineShare(d) * 100)}% of daylight`
          : 'no daylight',
    },
    {
      weight: 0.2,
      curve: [
        [15, 1],
        [45, 0.3],
      ],
      value: windKmh,
      note: windNote,
    },
  ],
};

export const outdoorSightseeing: ActivityScorer = {
  activity: 'OUTDOOR_SIGHTSEEING',
  inputs: outdoorModel.inputs,
  score: (day) => scoreActivity(outdoorModel, day),
};
