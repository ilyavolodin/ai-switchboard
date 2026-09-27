import { useId } from 'react';

export interface LogoProps {
  size?: number;
  /**
   * The colour of the gap where the rails cross — the surface the mark sits on
   * (default `var(--sidebar-bg)`).
   */
  gapColor?: string;
  /** Accessible name; `null` hides the mark from assistive tech (when text sits beside it). */
  label?: string | null;
}

/**
 * The AI Switchboard mark ("Cg"): two crossover rails, tangerine → sun over sky → teal, no tile.
 * Geometry copied from the canvas Rail. The gradient stops are the brand's fixed colours.
 */
export function Logo({
  size = 34,
  gapColor = 'var(--sidebar-bg)',
  label = 'AI Switchboard',
}: LogoProps) {
  const id = useId();
  const warm = `${id}-warm`;
  const cool = `${id}-cool`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      style={{ flexShrink: 0 }}
    >
      <linearGradient id={warm} gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="90" y2="0">
        <stop offset="0" stopColor="var(--tangerine)" />
        <stop offset="1" stopColor="var(--sun)" />
      </linearGradient>
      <linearGradient id={cool} gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="90" y2="0">
        <stop offset="0" stopColor="var(--sky)" />
        <stop offset="1" stopColor="var(--teal)" />
      </linearGradient>
      <path d="M10 68 H30 C46 68 54 32 70 32 H90" stroke={`url(#${cool})`} strokeWidth="6.5" />
      <path d="M42 40 C48 48 52 52 58 60" stroke={gapColor} strokeWidth="11.5" />
      <path d="M10 32 H30 C46 32 54 68 70 68 H90" stroke={`url(#${warm})`} strokeWidth="6.5" />
    </svg>
  );
}
