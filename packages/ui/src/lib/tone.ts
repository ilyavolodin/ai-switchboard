import type { RunStatusValue, StatusTone, StepStatus } from '@ai-switchboard/core/contract';

/** In the order the UI sorts by urgency. */
export const TONES = ['error', 'warn', 'ok', 'off'] as const satisfies readonly StatusTone[];

export function toneVars(tone: StatusTone): { fill: string; bg: string; fg: string } {
  const key = tone === 'error' ? 'err' : tone;
  return { fill: `var(--st-${key})`, bg: `var(--st-${key}-bg)`, fg: `var(--st-${key}-fg)` };
}

export function runStatusTone(status: RunStatusValue): StatusTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'error':
    case 'failed':
      return 'error';
    case 'held':
    case 'uncertain':
    case 'unknown':
      return 'warn';
    case 'invoking':
    case 'running':
      return 'off';
  }
}

/** In doubt (`started`, `uncertain`) is a warning. */
export function stepStatusTone(status: StepStatus): { tone: StatusTone; label: string } {
  switch (status) {
    case 'ok':
      return { tone: 'ok', label: 'ok' };
    case 'error':
      return { tone: 'error', label: 'error' };
    case 'started':
      return { tone: 'warn', label: 'started' };
    case 'uncertain':
      return { tone: 'warn', label: 'in doubt' };
    case 'skipped':
      return { tone: 'off', label: 'skipped' };
  }
}

export function toneRank(tone: StatusTone): number {
  return TONES.indexOf(tone);
}
