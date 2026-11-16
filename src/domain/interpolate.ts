/** Points (x, y) with x strictly increasing and y in [0, 1]. */
export type Curve = readonly (readonly [x: number, y: number])[];

/**
 * Piecewise-linear interpolation through the curve's points, clamped to the first y below the
 * first point and to the last y above the last point.
 *
 * At a knot it returns the knot's y exactly: the comparison `x < x1` is strict, so a knot is
 * always evaluated as the start of the next segment, where the offset `x - x0` is exactly 0.
 */
export function interpolate(curve: Curve, x: number): number {
  // NaN would otherwise fall through every comparison and silently score as the last point.
  if (!Number.isFinite(x)) throw new Error(`Cannot score a non-finite value: ${x}`);

  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!first || !last) throw new Error('A curve needs at least one point');

  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];

  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1]!;
    const [x1, y1] = curve[i]!;
    if (x < x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}
