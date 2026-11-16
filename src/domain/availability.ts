import {
  MARINE_FIELDS,
  type ActivityScorer,
  type DailyWeather,
  type UnavailableReason,
} from './types';

/**
 * An activity is scored only if every input it reads is present on every day of the week.
 * Returns why it cannot be scored, or null when it can. The first rule that applies wins:
 *
 * 1. It reads marine data and any day was written by a refresh whose marine request failed
 *    → MARINE_TEMPORARILY_UNAVAILABLE. The flag is checked before the values, so a failed
 *    marine request is never shown as available, whatever wave values other days hold.
 * 2. It reads marine data and all of it is null on every day → NO_MARINE_DATA (inland).
 * 3. Any input it reads is null on any day → INCOMPLETE_DATA.
 */
export function checkAvailability(
  scorer: Pick<ActivityScorer, 'inputs'>,
  week: readonly DailyWeather[],
): UnavailableReason | null {
  const marineInputs = scorer.inputs.filter((field) => MARINE_FIELDS.includes(field));

  if (marineInputs.length > 0) {
    if (week.some((day) => !day.marineFetched)) return 'MARINE_TEMPORARILY_UNAVAILABLE';
    if (week.every((day) => marineInputs.every((field) => day[field] === null))) {
      return 'NO_MARINE_DATA';
    }
  }

  if (week.some((day) => scorer.inputs.some((field) => day[field] === null))) {
    return 'INCOMPLETE_DATA';
  }
  return null;
}
