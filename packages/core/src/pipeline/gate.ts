import type { Health } from '@ai-switchboard/sdk';

import type { QuietWindow } from '../domain/process.js';
import type { ApprovalState, BatchKind, HoldReason } from '../domain/status.js';

import { breakerAtGate, breakerClosesAt, type BreakerState } from './breaker.js';
import { inQuietHours } from './quiet-hours.js';

export interface GateInput {
  kind: BatchKind;
  dryRun: boolean;
  process: { enabled: boolean };
  sources: readonly { id: string; enabled: boolean }[];
  destination: {
    exists: boolean;
    enabled: boolean;
    pluginAvailable: boolean;
    /** False when secrets failed or create threw. */
    live: boolean;
    instanceError?: string | undefined;
    health: Health | null;
  };
  breaker: BreakerState & { cooldownMinutes: number };
  quietHours: QuietWindow | null;
  defaultTimezone: string;
  approval: {
    rule: string;
    /** For an expression rule, errors count as required. */
    required: boolean;
    state: ApprovalState;
    error?: string;
  };
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
} & ({ pass: true } | { pass: false; reason: HoldReason; detail?: string });

export function gate(input: GateInput, now: Date): GateResult {
  const checks: GateCheck[] = [];
  let breakerClosed = false;
  const hold = (reason: HoldReason, check: string, detail?: string): GateResult => {
    checks.push({ check, pass: false, ...(detail !== undefined ? { detail } : {}) });
    return {
      pass: false,
      reason,
      ...(detail !== undefined ? { detail } : {}),
      checks,
      breakerClosed,
    };
  };
  const pass = (check: string, detail?: string): void => {
    checks.push({ check, pass: true, ...(detail !== undefined ? { detail } : {}) });
  };

  if (!input.process.enabled) return hold('process_disabled', 'process_enabled');
  pass('process_enabled');

  const disabled = input.sources.filter((s) => !s.enabled).map((s) => s.id);
  if (disabled.length > 0) return hold('source_disabled', 'sources_enabled', disabled.join(','));
  pass('sources_enabled', input.sources.length === 0 ? 'no events' : undefined);

  const ex = input.destination;
  if (!ex.exists) return hold('destination_disabled', 'destination_enabled', 'destination missing');
  if (!ex.enabled) return hold('destination_disabled', 'destination_enabled');
  pass('destination_enabled');
  if (!ex.pluginAvailable || ex.instanceError === 'plugin_unavailable') {
    return hold('plugin_unavailable', 'plugin_available');
  }
  pass('plugin_available');
  if (!ex.live)
    return hold(
      'destination_unhealthy',
      'destination_healthy',
      ex.instanceError ?? 'no live instance',
    );
  if (ex.health?.status === 'unhealthy') {
    return hold('destination_unhealthy', 'destination_healthy', ex.health.message ?? 'unhealthy');
  }
  pass('destination_healthy');

  const breaker = breakerAtGate(input.breaker, input.breaker.cooldownMinutes, now);
  breakerClosed = breaker.transition === 'closed_cooldown';
  if (breaker.next.state === 'open') {
    const closesAt = breakerClosesAt(input.breaker, input.breaker.cooldownMinutes);
    return hold(
      'breaker_open',
      'breaker_closed',
      closesAt ? `closes at ${closesAt.toISOString()}` : 'reset by hand',
    );
  }
  pass('breaker_closed', breakerClosed ? 'closed after cooldown' : undefined);

  if (input.quietHours && inQuietHours(input.quietHours, now, input.defaultTimezone)) {
    const w = input.quietHours;
    return hold(
      'quiet_hours',
      'outside_quiet_hours',
      `${w.start}–${w.end} ${w.timezone ?? input.defaultTimezone}`,
    );
  }
  pass('outside_quiet_hours');

  const a = input.approval;
  if (input.dryRun) {
    pass('approval', 'dry run');
  } else if (a.rule === 'none') {
    pass('approval', 'none');
  } else if (a.state === 'approved') {
    pass('approval', 'approved');
  } else if (!a.required) {
    pass('approval', 'not required');
  } else {
    return hold(
      'awaiting_approval',
      'approval',
      a.error !== undefined ? `${a.rule} (error: ${a.error})` : a.rule,
    );
  }
  return { pass: true, checks, breakerClosed };
}
