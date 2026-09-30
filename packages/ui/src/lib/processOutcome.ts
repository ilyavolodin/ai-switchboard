import type { ActivityRow, StatusLabel } from '@ai-switchboard/core/contract';

export type ProcessOutcome = ActivityRow['processes'][number];

/** The run's status once there is a run, else what the pipeline did with the event. */
export function processOutcomeLabel(p: ProcessOutcome): StatusLabel {
  return p.statusLabel
    ? { tone: p.statusLabel.tone, label: `run ${p.statusLabel.label}` }
    : { tone: 'off', label: p.outcome.replace(/_/g, ' ') };
}
