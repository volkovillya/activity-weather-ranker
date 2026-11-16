import { describe, expect, it } from '@jest/globals';
import { interpolate, type Curve } from '../../../src/domain/interpolate';

// S0
describe('interpolate', () => {
  const rising: Curve = [
    [5, 0],
    [40, 1],
  ];
  const surfHeightGate: Curve = [
    [0.3, 0],
    [0.8, 1],
    [2.5, 1],
    [4.5, 0],
  ];
  const rainGate: Curve = [
    [1, 1],
    [10, 0.6],
    [30, 0.2],
    [60, 0],
  ];

  it('returns the exact y value at every knot', () => {
    for (const curve of [rising, surfHeightGate, rainGate]) {
      for (const [x, y] of curve) expect(interpolate(curve, x)).toBe(y);
    }
  });

  it('interpolates linearly between knots', () => {
    expect(interpolate(rising, 22.5)).toBeCloseTo(0.5, 12);
    expect(interpolate(rainGate, 20)).toBeCloseTo(0.4, 12);
    expect(interpolate(rainGate, 45)).toBeCloseTo(0.1, 12);
  });

  it('clamps to the first value below the first knot and the last value above the last', () => {
    expect(interpolate(rising, -100)).toBe(0);
    expect(interpolate(rising, 1000)).toBe(1);
    expect(interpolate(rainGate, 0)).toBe(1);
    expect(interpolate(rainGate, 500)).toBe(0);
  });

  it('handles a two-sided curve (too small and too big both score low)', () => {
    expect(interpolate(surfHeightGate, 0.55)).toBeCloseTo(0.5, 12);
    expect(interpolate(surfHeightGate, 1.6)).toBe(1);
    expect(interpolate(surfHeightGate, 3.5)).toBeCloseTo(0.5, 12);
    expect(interpolate(surfHeightGate, 9)).toBe(0);
  });
});
