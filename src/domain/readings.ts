import { formatValue, required } from './scoreActivity';
import type { DailyWeather } from './types';

// Inputs read by more than one activity, with one wording for each so reasons stay consistent.

export const windKmh = (d: DailyWeather) => required(d, 'windSpeedMaxKmh');
export const windNote = (d: DailyWeather) => `wind ${formatValue(windKmh(d))} km/h`;

export const tempMaxC = (d: DailyWeather) => required(d, 'tempMaxC');
export const tempNote = (d: DailyWeather) => `max temperature ${formatValue(tempMaxC(d))} °C`;

export const precipitationMm = (d: DailyWeather) => required(d, 'precipitationMm');
export const precipitationNote = (d: DailyWeather) =>
  `precipitation ${formatValue(precipitationMm(d))} mm`;
