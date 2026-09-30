import type { SettledRunStatus } from '@ai-switchboard/core/domain';

import type { ReasonPromptOptions } from '../../hooks/reason.js';

export type InstanceNoun = 'source' | 'destination' | 'notifier' | 'secret provider';

const the = (name: string | undefined, noun: string) => name ?? `the ${noun}`;

export function resetBreakerPrompt(processName?: string): ReasonPromptOptions {
  return {
    title: processName ? `Reset the ${processName} breaker?` : 'Reset the breaker?',
    consequence:
      'Event runs resume immediately and the failure count starts again from zero; the breaker opens again if runs keep failing.',
    confirmLabel: 'Reset breaker',
  };
}

export function approvePrompt(processName?: string): ReasonPromptOptions {
  return {
    title: processName ? `Approve the ${processName} batch?` : 'Approve this batch?',
    consequence: 'The batch re-enters the gate and runs if its budget allows.',
    confirmLabel: 'Approve',
  };
}

export function rejectPrompt(processName?: string): ReasonPromptOptions {
  return {
    title: processName ? `Reject the ${processName} batch?` : 'Reject this batch?',
    consequence: 'The batch is dropped and never runs. Its events stay in Activity.',
    confirmLabel: 'Reject',
    danger: true,
  };
}

export function reloadPrompt(noun: InstanceNoun, name?: string): ReasonPromptOptions {
  return {
    title: `Reload ${the(name, noun)}?`,
    consequence:
      noun === 'destination'
        ? 'The live plugin object is re-created from the saved settings and secrets are resolved again; open runs keep being tracked.'
        : 'The live plugin object is re-created from the saved settings and secrets are resolved again.',
    confirmLabel: 'Reload',
  };
}

export const reloadedMessage = (noun: InstanceNoun) =>
  `${noun.charAt(0).toUpperCase()}${noun.slice(1)} reloaded`;

export function readMetersPrompt(destinationName?: string): ReasonPromptOptions {
  return {
    title: destinationName ? `Read the meters of ${destinationName} now?` : 'Read meters now?',
    consequence:
      'Switchboard asks the backend for fresh readings now instead of waiting for the next poll.',
    confirmLabel: 'Read meters',
  };
}

export function testEventPrompt(sourceName?: string): ReasonPromptOptions {
  return {
    title: sourceName ? `Send a test event from ${sourceName}?` : 'Send a test event?',
    consequence:
      'A synthetic event walks the pipeline like a real one: processes whose triggers match it will batch and may run.',
    confirmLabel: 'Send test event',
  };
}

export function enableProcessPrompt(
  processName: string | undefined,
  enabled: boolean,
  consequence?: string,
): ReasonPromptOptions {
  const name = the(processName, 'process');
  return {
    title: `${enabled ? 'Enable' : 'Disable'} ${name}?`,
    consequence:
      consequence ??
      (enabled
        ? 'Its triggers and sweeps start runs from now on, under its budgets and gates.'
        : 'Its triggers and sweeps stop: no new runs start. Runs already started keep going.'),
    confirmLabel: processName
      ? `${enabled ? 'Enable' : 'Disable'} ${processName}`
      : enabled
        ? 'Enable'
        : 'Disable',
    danger: !enabled,
  };
}

export function runProcessPrompt(processName: string): ReasonPromptOptions {
  return {
    title: `Run ${processName} now?`,
    consequence:
      'Starts a manual run with the open batch, or an empty sweep context — it passes the same gates and budgets as any other run.',
    confirmLabel: 'Run now',
  };
}

export function testRunPrompt(processName: string, dryRun: boolean): ReasonPromptOptions {
  return {
    title: `Test run ${processName || 'this process'}?`,
    consequence: dryRun
      ? 'Invokes the saved version with the chosen batch and a dry-run flag; destinations that honour it change nothing.'
      : 'Invokes the saved version for real with the chosen batch: it spends budget and may change things.',
    confirmLabel: 'Start test run',
    danger: !dryRun,
  };
}

/** The toast after a manual or test run, e.g. "Run started · r-12". */
export function runStartedMessage(
  label: 'Run' | 'Test run',
  r: { outcome: string; runId?: string | null },
): string {
  return `${label} ${r.outcome}${r.runId ? ` · ${r.runId}` : ''}`;
}

export function deleteProcessPrompt(processName: string, consequence: string): ReasonPromptOptions {
  return {
    title: `Delete ${processName}?`,
    consequence,
    confirmLabel: `Delete ${processName}`,
    danger: true,
  };
}

export function restoreVersionPrompt(
  processName: string,
  version: number,
  currentVersion: number,
): ReasonPromptOptions {
  return {
    title: `Restore version ${version} of ${processName}?`,
    consequence: `Version ${version}'s document is saved as version ${currentVersion + 1}; the current version stays in the history.`,
    confirmLabel: 'Restore',
  };
}

const SETTLE_CONSEQUENCE: Record<SettledRunStatus, string> = {
  ok: 'The run counts as a success: it stops being tracked and the breaker sees no failure.',
  error:
    'The run counts as a failure: it stops being tracked and adds to the breaker’s failure count.',
  unknown:
    'The run stops being tracked without an outcome; like a failure, it adds to the breaker’s count.',
};

export function closeRunPrompt(status: SettledRunStatus): ReasonPromptOptions {
  return {
    title: `Settle the run as ${status}?`,
    consequence: `${SETTLE_CONSEQUENCE[status]} Nothing is sent to the destination.`,
    confirmLabel: `Mark ${status}`,
  };
}
