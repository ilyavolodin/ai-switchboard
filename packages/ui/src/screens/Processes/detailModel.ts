import type { ProcessDetail, StatsWindow } from '@ai-switchboard/core/contract';

import { toMs } from '../../lib/format.js';

export const WINDOWS: { value: StatsWindow; label: string }[] = [
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
  { value: '30d', label: '30 d' },
];

export function windowLabel(w: StatsWindow): string {
  return WINDOWS.find((x) => x.value === w)?.label ?? w;
}

/** The first is the default (no segment). */
export const DETAIL_TABS = ['activity', 'runs', 'definition', 'history'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

export function asDetailTab(tab: string | undefined): DetailTab | null {
  if (tab == null) return 'activity';
  return (DETAIL_TABS as readonly string[]).includes(tab) ? (tab as DetailTab) : null;
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function enableConsequence(p: ProcessDetail, enable: boolean): string {
  const triggers = p.document.triggers.filter((t) => t.enabled).length;
  const sweeps = p.document.schedules.filter((s) => s.enabled).length;
  const what = [plural(triggers, 'trigger'), plural(sweeps, 'sweep')].join(' and ');
  if (enable) {
    return `Enabling ${p.name} lets its ${what} start runs again, under its budgets and gates.`;
  }
  return `Disabling ${p.name} stops its ${what}: no new runs start${
    p.awaitingApproval > 0
      ? `, and ${plural(p.awaitingApproval, 'batch', 'batches')} awaiting approval ${
          p.awaitingApproval === 1 ? 'stays' : 'stay'
        } parked`
      : ''
  }. Open batches are dropped; runs already started keep going.`;
}

export function deleteConsequence(p: ProcessDetail): string {
  const approvals =
    p.awaitingApproval > 0
      ? `, and its ${plural(p.awaitingApproval, 'pending approval')} ${
          p.awaitingApproval === 1 ? 'is' : 'are'
        } withdrawn`
      : '';
  return `Its triggers and sweeps stop for good. Its open batches are dropped${approvals}. Runs already started finish; runs and events stay for the trace, and the audit log keeps its last version. This cannot be undone.`;
}

export function cooldownEndsAt(p: ProcessDetail): string | null {
  const opened = toMs(p.breakerOpenedAt);
  if (opened == null) return null;
  return new Date(opened + p.document.gates.breaker.cooldownMinutes * 60_000).toISOString();
}

export function dayLabel(iso: string, window: StatsWindow): string {
  const d = new Date(iso);
  return window === '30d'
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleDateString(undefined, { weekday: 'short' });
}
