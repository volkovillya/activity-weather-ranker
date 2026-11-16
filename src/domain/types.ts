/** Activities in the order the API returns them. */
export const ACTIVITIES = [
  'SKIING',
  'SURFING',
  'OUTDOOR_SIGHTSEEING',
  'INDOOR_SIGHTSEEING',
] as const;

export type Activity = (typeof ACTIVITIES)[number];

/** Why an activity cannot be judged. "Unavailable" never means "bad weather". */
export type UnavailableReason =
  | 'NO_MARINE_DATA' // marine request succeeded, but there is no wave data on any day (inland)
  | 'MARINE_TEMPORARILY_UNAVAILABLE' // marine request failed; it is retried later
  | 'INCOMPLETE_DATA'; // an input this activity needs is missing on at least one day

/**
 * Stored weather for one location-local day. Every measurement carries its unit in its name
 * and may be null: Open-Meteo can return nulls, and nulls are data, not failures.
 */
export interface DailyWeather {
  /** YYYY-MM-DD in the location's time zone. */
  date: string;
  /** True when the marine request of the refresh that wrote this day succeeded. */
  marineFetched: boolean;
  tempMaxC: number | null;
  precipitationMm: number | null;
  snowfallCm: number | null;
  snowDepthM: number | null;
  windSpeedMaxKmh: number | null;
  sunshineS: number | null;
  daylightS: number | null;
  waveHeightMaxM: number | null;
  swellPeriodMaxS: number | null;
}

export type WeatherField = Exclude<keyof DailyWeather, 'date' | 'marineFetched'>;

export const MARINE_FIELDS: readonly WeatherField[] = ['waveHeightMaxM', 'swellPeriodMaxS'];

/** The score of one activity on one day, with what produced it. */
export interface ScoreBreakdown {
  /** Integer 0–100. */
  score: number;
  /** 0–1: can the activity be done at all. */
  gate: number;
  /** 0–1: how pleasant it is. Null for indoor sightseeing, which is derived from outdoor. */
  quality: number | null;
  reasons: string[];
}

/** One activity: the inputs it reads and how it scores a day. */
export interface ActivityScorer {
  activity: Activity;
  inputs: readonly WeatherField[];
  score(day: DailyWeather): ScoreBreakdown;
}

export interface DayScore {
  date: string;
  score: number;
  rank: number;
  reasons: string[];
}

export interface ActivityRanking {
  activity: Activity;
  available: boolean;
  /** Non-null exactly when `available` is false. */
  unavailableReason: UnavailableReason | null;
  /** Every day of the week in input order when available; empty otherwise. */
  days: DayScore[];
}
