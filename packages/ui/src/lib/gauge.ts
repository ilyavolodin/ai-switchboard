/**
 * Geometry of the meter arc used by `MeterGauge` (a 56×56 viewBox, radius 22, starting at 12
 * o'clock and running clockwise). Kept pure so the arithmetic is unit-tested.
 */

export const GAUGE_VIEWBOX = 56;
export const GAUGE_CENTER = 28;
export const GAUGE_RADIUS = 22;
export const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

/** Clamps a fraction to 0–1; `null`/NaN become 0. */
export function clampFraction(f: number | null | undefined): number {
  if (f == null || Number.isNaN(f)) return 0;
  return Math.min(1, Math.max(0, f));
}

/** The `stroke-dasharray` of the used arc: `"<used length> <circumference>"`, one decimal. */
export function arcDasharray(fraction: number): string {
  const used = clampFraction(fraction) * GAUGE_CIRCUMFERENCE;
  return `${used.toFixed(1)} ${GAUGE_CIRCUMFERENCE.toFixed(1)}`;
}

/** A tick across the ring at `percent` (0–100): a line from radius 17 to 27. */
export function ceilingMark(percent: number): { x1: number; y1: number; x2: number; y2: number } {
  const angle = ((-90 + 3.6 * Math.min(100, Math.max(0, percent))) * Math.PI) / 180;
  const at = (r: number) => ({
    x: round1(GAUGE_CENTER + r * Math.cos(angle)),
    y: round1(GAUGE_CENTER + r * Math.sin(angle)),
  });
  const inner = at(17);
  const outer = at(27);
  return { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * The used fraction (0–1) of a meter. `utilization` is a percentage (0–100) as the SDK reports
 * it; allowances without one fall back to used / limit.
 */
export function meterFraction(m: {
  utilization: number | null;
  used: number | null;
  limit: number | null;
}): number | null {
  if (m.utilization != null) return clampFraction(m.utilization / 100);
  if (m.used != null && m.limit != null && m.limit > 0) return clampFraction(m.used / m.limit);
  return null;
}
