/** Shared arithmetic for the hand-rolled SVG charts (bars, sparklines, meter bands). */

/**
 * A value a chart can draw: finite and not negative. Missing, NaN, infinite and negative values
 * draw as 0, so one bad data point never turns a whole chart's geometry into NaN.
 */
export function chartValue(v: number | null | undefined): number {
  return v != null && Number.isFinite(v) && v > 0 ? v : 0;
}
