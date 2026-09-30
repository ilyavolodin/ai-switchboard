import type { RunStatusValue, StatusTone, StepStatus } from '@ai-switchboard/core/contract';
import { RUN_STATUS_LABELS, stepTone } from '@ai-switchboard/core/domain';

export { toneRank } from '@ai-switchboard/core/domain';

export function toneVars(tone: StatusTone): { fill: string; bg: string; fg: string } {
  const key = tone === 'error' ? 'err' : tone;
  return { fill: `var(--st-${key})`, bg: `var(--st-${key}-bg)`, fg: `var(--st-${key}-fg)` };
}

export function runStatusTone(status: RunStatusValue): StatusTone {
  return RUN_STATUS_LABELS[status].tone;
}

/** In doubt (`started`, `uncertain`) is a warning. */
export function stepStatusTone(status: StepStatus): { tone: StatusTone; label: string } {
  return { tone: stepTone(status), label: status === 'uncertain' ? 'in doubt' : status };
}
