import { describe, expect, it } from '@jest/globals';
import { addDays, localToday, weekDates } from '../../../src/domain/dates';

// D1
describe('localToday', () => {
  const at = new Date('2026-11-16T20:00:00Z');

  it('is already tomorrow in a zone ahead of UTC', () => {
    expect(localToday('Australia/Sydney', at)).toBe('2026-11-17');
  });

  it('is still today in a zone behind UTC, and in UTC itself', () => {
    expect(localToday('America/Los_Angeles', at)).toBe('2026-11-16');
    expect(localToday('UTC', at)).toBe('2026-11-16');
  });

  it('changes exactly at local midnight', () => {
    // Europe/Warsaw is UTC+1 in November.
    expect(localToday('Europe/Warsaw', new Date('2026-11-16T22:59:59Z'))).toBe('2026-11-16');
    expect(localToday('Europe/Warsaw', new Date('2026-11-16T23:00:00Z'))).toBe('2026-11-17');
  });
});

// D2
describe('addDays', () => {
  it.each([
    ['2026-03-28', 1, '2026-03-29'], // the night clocks go forward in Europe
    ['2026-03-29', 1, '2026-03-30'],
    ['2026-10-25', 1, '2026-10-26'], // the day clocks go back in Europe (25 hours long)
    ['2026-01-31', 1, '2026-02-01'], // month end
    ['2026-12-31', 1, '2027-01-01'], // year end
    ['2028-02-28', 1, '2028-02-29'], // leap year
    ['2026-11-16', 6, '2026-11-22'],
    ['2026-11-16', 0, '2026-11-16'],
  ])('%s + %i day(s) = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe('weekDates', () => {
  it('returns seven consecutive local dates starting today', () => {
    expect(weekDates('Australia/Sydney', new Date('2026-11-16T20:00:00Z'))).toEqual([
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
      '2026-11-23',
    ]);
  });

  it('spans a daylight-saving change without skipping or repeating a date', () => {
    expect(weekDates('Europe/Paris', new Date('2026-10-22T12:00:00Z'))).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
    ]);
  });
});
