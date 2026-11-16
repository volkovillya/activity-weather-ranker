/** Calendar dates are 'YYYY-MM-DD' strings throughout: no JS Date, so no hidden time zone. */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar date it is at `now` in `timeZone` (for Sydney at 20:00 UTC, already tomorrow). */
export function localToday(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Pure calendar arithmetic, done at UTC midnight where every day has 24 hours, so a
 * daylight-saving change in the location's zone cannot skip or repeat a date.
 */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Today and the six following days in the location's time zone. */
export function weekDates(timeZone: string, now: Date): string[] {
  const today = localToday(timeZone, now);
  return Array.from({ length: 7 }, (_, i) => addDays(today, i));
}
