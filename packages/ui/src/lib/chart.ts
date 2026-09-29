/** Missing, NaN, infinite and negative values draw as 0, so one bad point can't NaN the geometry. */
export function chartValue(v: number | null | undefined): number {
  return v != null && Number.isFinite(v) && v > 0 ? v : 0;
}
