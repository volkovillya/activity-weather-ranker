import { interpolate, type Curve } from './interpolate';
import type { DailyWeather, ScoreBreakdown, WeatherField } from './types';

/** One input of an activity: how to read it from a day, how to score it, how to describe it. */
export interface Measure {
  curve: Curve;
  value(day: DailyWeather): number;
  note(day: DailyWeather): string;
}

export interface Factor extends Measure {
  /** Factor weights of one activity sum to 1. */
  weight: number;
}

/**
 * score = round(100 × gate × quality)
 *   gate    = the lowest gate — "can you do it at all"; 1 in normal conditions, 0 at extremes
 *   quality = weighted mean of the factors — "how pleasant is it"
 * Multiplying (rather than taking a minimum) keeps days apart when one input is constant.
 */
export interface ActivityModel {
  /** Every weather field the gates and factors read; used to decide availability. */
  inputs: readonly WeatherField[];
  gates: readonly Measure[];
  factors: readonly Factor[];
}

/**
 * Rounds halves up. The epsilon absorbs floating-point error: 100 × 0.5 × 0.79 evaluates to
 * 39.49999999999999, which plain Math.round would turn into 39 instead of 40.
 */
export function roundScore(x: number): number {
  return Math.round(x + 1e-9);
}

/** At most one decimal, without trailing zeros: 20 → "20", 9.87 → "9.9". */
export function formatValue(x: number): string {
  return String(Math.round(x * 10) / 10);
}

/**
 * Reads an input that scoring needs. A null here means availability was not checked first,
 * which is a bug, so it fails loudly instead of scoring with a made-up value.
 */
export function required(day: DailyWeather, field: WeatherField): number {
  const value = day[field];
  if (value === null) {
    throw new Error(`${field} is missing on ${day.date}; the activity should be unavailable`);
  }
  return value;
}

/** Evaluates gates: the lowest gate value, and a "Limited by …" reason for each gate below 1. */
export function evaluateGates(gates: readonly Measure[], day: DailyWeather) {
  const values = gates.map((g) => interpolate(g.curve, g.value(day)));
  return {
    gate: Math.min(1, ...values),
    limitedBy: gates.filter((_, i) => values[i]! < 1).map((g) => `Limited by ${g.note(day)}`),
  };
}

export function scoreActivity(model: ActivityModel, day: DailyWeather): ScoreBreakdown {
  const { gate, limitedBy } = evaluateGates(model.gates, day);
  const quality = model.factors.reduce(
    (sum, f) => sum + f.weight * interpolate(f.curve, f.value(day)),
    0,
  );
  return {
    score: roundScore(100 * gate * quality),
    gate,
    quality,
    reasons: [...limitedBy, ...model.factors.map((f) => f.note(day))],
  };
}
