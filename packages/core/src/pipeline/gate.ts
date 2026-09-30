import type { Health } from '@ai-switchboard/sdk';

import { formatInstanceError, type InstanceError } from '../domain/instance-error.js';
import { approvalMode, type QuietWindow } from '../domain/process.js';
import type { ApprovalState, HoldReason } from '../domain/status.js';

import { breakerAtGate, type BreakerState } from './breaker.js';
import { inQuietHours } from './quiet-hours.js';

/** The approval expression's outcome; an error asks a person (fail closed). */
export interface ApprovalEvaluation {
  result: boolean;
  error?: string;
}

export interface GateInput {
  dryRun: boolean;
  process: { enabled: boolean };
  sources: readonly { id: string; enabled: boolean }[];
  destination: {
    exists: boolean;
    enabled: boolean;
    pluginAvailable: boolean;
    /** False when secrets failed or create threw. */
    live: boolean;
    instanceError?: InstanceError | undefined;
    health: Health | null;
  };
  breaker: BreakerState & { cooldownMinutes: number };
  quietHours: QuietWindow | null;
  defaultTimezone: string;
  approval: {
    rule: string;
    state: ApprovalState;
    /** Absent until the expression has been evaluated; the gate asks for it when it gets there. */
    evaluated?: ApprovalEvaluation | undefined;
  };
}

export type ApprovalCheck =
  | { outcome: 'pass'; detail: string }
  | { outcome: 'hold'; detail: string }
  | { outcome: 'evaluate' };

/** The last gate check. `evaluate` means only the rule's expression can decide. */
export function approvalCheck(
  rule: string,
  batch: { dryRun: boolean; approvalState: ApprovalState },
  evaluated: ApprovalEvaluation | undefined,
): ApprovalCheck {
  if (batch.dryRun) return { outcome: 'pass', detail: 'dry run' };
  const mode = approvalMode(rule);
  if (mode === 'none') return { outcome: 'pass', detail: 'none' };
  if (batch.approvalState === 'approved') return { outcome: 'pass', detail: 'approved' };
  if (mode === 'always') return { outcome: 'hold', detail: rule };
  if (evaluated === undefined) return { outcome: 'evaluate' };
  if (evaluated.error !== undefined) {
    return { outcome: 'hold', detail: `${rule} (error: ${evaluated.error})` };
  }
  return evaluated.result
    ? { outcome: 'hold', detail: rule }
    : { outcome: 'pass', detail: 'not required' };
}

export interface GateCheck {
  check: string;
  pass: boolean;
  detail?: string;
}

export type GateResult = {
  checks: GateCheck[];
  /** The cooldown elapsed during this check; the caller persists the close. */
  breakerClosed: boolean;
} & (
  | { pass: true }
  | { pass: false; reason: HoldReason; detail?: string }
  /** Every earlier check passed: evaluate the approval expression and run the gate again. */
  | { pass: false; evaluateApproval: true }
);

export type SettledGateResult = Exclude<GateResult, { evaluateApproval: true }>;

/** A result still waiting on the approval expression holds the batch for a person (fail closed). */
export function settledGate(result: GateResult): SettledGateResult {
  if (!('evaluateApproval' in result)) return result;
  return {
    pass: false,
    reason: 'awaiting_approval',
    detail: 'approval not evaluated',
    checks: result.checks,
    breakerClosed: result.breakerClosed,
  };
}

export function gate(input: GateInput, now: Date): GateResult {
  const checks: GateCheck[] = [];
  let breakerClosed = false;
  const record = (check: string, pass: boolean, detail?: string): void => {
    checks.push({ check, pass, ...(detail !== undefined ? { detail } : {}) });
  };
  const hold = (reason: HoldReason, check: string, detail?: string): GateResult => {
    record(check, false, detail);
    return {
      pass: false,
      reason,
      ...(detail !== undefined ? { detail } : {}),
      checks,
      breakerClosed,
    };
  };

  if (!input.process.enabled) return hold('process_disabled', 'process_enabled');
  record('process_enabled', true);

  const disabled = input.sources.filter((s) => !s.enabled).map((s) => s.id);
  if (disabled.length > 0) return hold('source_disabled', 'sources_enabled', disabled.join(','));
  record('sources_enabled', true, input.sources.length === 0 ? 'no events' : undefined);

  const dest = input.destination;
  if (!dest.exists) {
    return hold('destination_disabled', 'destination_enabled', 'destination missing');
  }
  if (!dest.enabled) return hold('destination_disabled', 'destination_enabled');
  record('destination_enabled', true);
  if (!dest.pluginAvailable || dest.instanceError?.code === 'plugin_unavailable') {
    return hold('plugin_unavailable', 'plugin_available');
  }
  record('plugin_available', true);
  if (!dest.live) {
    return hold(
      'destination_unhealthy',
      'destination_healthy',
      dest.instanceError ? formatInstanceError(dest.instanceError) : 'no live instance',
    );
  }
  if (dest.health?.status === 'unhealthy') {
    return hold('destination_unhealthy', 'destination_healthy', dest.health.message ?? 'unhealthy');
  }
  record('destination_healthy', true);

  const breaker = breakerAtGate(input.breaker, input.breaker.cooldownMinutes, now);
  breakerClosed = breaker.transition === 'closed_cooldown';
  if (breaker.next.state === 'open') {
    return hold(
      'breaker_open',
      'breaker_closed',
      breaker.closesAt ? `closes at ${breaker.closesAt.toISOString()}` : 'reset by hand',
    );
  }
  record('breaker_closed', true, breakerClosed ? 'closed after cooldown' : undefined);

  if (input.quietHours && inQuietHours(input.quietHours, now, input.defaultTimezone)) {
    const w = input.quietHours;
    return hold(
      'quiet_hours',
      'outside_quiet_hours',
      `${w.start}–${w.end} ${w.timezone ?? input.defaultTimezone}`,
    );
  }
  record('outside_quiet_hours', true);

  const a = input.approval;
  const approval = approvalCheck(
    a.rule,
    { dryRun: input.dryRun, approvalState: a.state },
    a.evaluated,
  );
  switch (approval.outcome) {
    case 'evaluate':
      return { pass: false, evaluateApproval: true, checks, breakerClosed };
    case 'hold':
      return hold('awaiting_approval', 'approval', approval.detail);
    case 'pass':
      record('approval', true, approval.detail);
      return { pass: true, checks, breakerClosed };
  }
}
