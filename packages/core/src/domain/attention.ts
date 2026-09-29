import type { Health } from '@ai-switchboard/sdk';

import type { StatusTone } from './status.js';

export interface AttentionItem {
  id: string;
  kind:
    | 'breaker'
    | 'unhealthy'
    | 'meter_stale'
    | 'source_silent'
    | 'approval'
    | 'plugin_unavailable'
    | 'uncertain_runs'
    /** A disabled process that has never run turned away events in the last 24 h. */
    | 'process_disabled';
  tone: StatusTone;
  title: string;
  detail: string;
  targetKind: 'process' | 'source' | 'destination' | 'plugin' | 'approval';
  targetId: string;
  /** The one-click action, e.g. `reset_breaker`, `approve`, `reload`, `read_meters`, `open`. */
  action: { id: string; label: string };
  since: string | null;
}

interface Labelled {
  id: string;
  name: string;
  typeId: string;
  enabled: boolean;
  pluginAvailable: boolean;
  status: { tone: StatusTone; label: string };
  health: Pick<Health, 'message' | 'checkedAt'> | null;
}

export interface AttentionInput {
  now: Date;
  sourceSilenceMinutes: number;
  processes: {
    id: string;
    name: string;
    breakerState: 'open' | 'closed';
    breakerOpenedAt: string | null;
    awaitingApproval: number;
  }[];
  sources: (Labelled & {
    mode: 'push' | 'pull' | 'both';
    processCount: number;
    lastEventAt: string | null;
  })[];
  destinations: (Labelled & {
    meters: {
      meterId: string;
      title: string;
      stale: boolean;
      estimated: boolean;
      observedAt: string | null;
    }[];
  })[];
  /** Uncertain runs per process. */
  uncertain: { processId: string; n: number }[];
  /** Disabled processes that never ran but turned events away in the last 24 h. */
  turnedAway: { processId: string; name: string; n: number }[];
  failedPlugins: { name: string; status: string }[];
}

const TONE_RANK: Readonly<Record<StatusTone, number>> = { error: 0, warn: 1, ok: 2, off: 3 };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function unavailableOrUnhealthy(
  x: Labelled,
  targetKind: 'source' | 'destination',
  held: string,
  unhealthyDetail: string,
): AttentionItem | null {
  if (!x.pluginAvailable) {
    return {
      id: `plugin:${x.id}`,
      kind: 'plugin_unavailable',
      tone: 'warn',
      title: `${x.name}: plugin unavailable`,
      detail: `The ${x.typeId} plugin is not loaded; ${held}.`,
      targetKind,
      targetId: x.id,
      action: { id: 'open', label: 'Open' },
      since: null,
    };
  }
  if (x.enabled && x.status.tone === 'error') {
    return {
      id: `unhealthy:${x.id}`,
      kind: 'unhealthy',
      tone: 'error',
      title: `${x.name}: ${x.status.label}`,
      detail: x.health?.message ?? unhealthyDetail,
      targetKind,
      targetId: x.id,
      action: { id: 'reload', label: 'Reload' },
      since: x.health?.checkedAt ?? null,
    };
  }
  return null;
}

/** The Board's attention list, worst first. */
export function attentionItems(input: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  const now = input.now.getTime();
  for (const p of input.processes) {
    if (p.breakerState === 'open') {
      out.push({
        id: `breaker:${p.id}`,
        kind: 'breaker',
        tone: 'error',
        title: `${p.name}: breaker open`,
        detail: 'Batches and sweeps are held until the breaker is reset or the cooldown passes.',
        targetKind: 'process',
        targetId: p.id,
        action: { id: 'reset_breaker', label: 'Reset' },
        since: p.breakerOpenedAt,
      });
    }
    if (p.awaitingApproval > 0) {
      out.push({
        id: `approval:${p.id}`,
        kind: 'approval',
        tone: 'warn',
        title: `${p.name}: ${p.awaitingApproval} awaiting approval`,
        detail: 'A person must approve or reject before the run starts.',
        targetKind: 'approval',
        targetId: p.id,
        action: { id: 'open_approvals', label: 'Review' },
        since: null,
      });
    }
  }
  const silenceMs = input.sourceSilenceMinutes * 60_000;
  for (const s of input.sources) {
    const item = unavailableOrUnhealthy(
      s,
      'source',
      'processes using it are held',
      'The source failed its last health check.',
    );
    if (item) out.push(item);
    if (s.enabled && s.mode !== 'pull' && s.processCount > 0) {
      const last = s.lastEventAt ? new Date(s.lastEventAt).getTime() : null;
      if (last === null || now - last > silenceMs) {
        out.push({
          id: `silent:${s.id}`,
          kind: 'source_silent',
          tone: 'warn',
          title: `${s.name}: silent`,
          detail:
            last === null ? 'No events received yet.' : 'No events within the silence window.',
          targetKind: 'source',
          targetId: s.id,
          action: { id: 'test_event', label: 'Send test event' },
          since: s.lastEventAt,
        });
      }
    }
  }
  for (const e of input.destinations) {
    const item = unavailableOrUnhealthy(
      e,
      'destination',
      'processes bound to it are held',
      'Processes bound to it are held.',
    );
    if (item) out.push(item);
    for (const m of e.meters) {
      if (e.enabled && m.stale && !m.estimated) {
        out.push({
          id: `stale:${e.id}:${m.meterId}`,
          kind: 'meter_stale',
          tone: 'warn',
          title: `${e.name}: ${m.title} is stale`,
          detail: m.observedAt
            ? 'Ceilings fall back to run counters until a fresh reading.'
            : 'Never read.',
          targetKind: 'destination',
          targetId: e.id,
          action: { id: 'read_meters', label: 'Read now' },
          since: m.observedAt,
        });
      }
    }
  }
  for (const u of input.uncertain) {
    const p = input.processes.find((x) => x.id === u.processId);
    out.push({
      id: `uncertain:${u.processId}`,
      kind: 'uncertain_runs',
      tone: 'warn',
      title: `${p?.name ?? 'A process'}: ${plural(u.n, 'uncertain run')}`,
      detail:
        'The invoke response was lost; tracking will settle it or the deadline marks it unknown.',
      targetKind: 'process',
      targetId: u.processId,
      action: { id: 'open', label: 'Open' },
      since: null,
    });
  }
  for (const t of input.turnedAway) {
    if (t.n === 0) continue;
    out.push({
      id: `disabled:${t.processId}`,
      kind: 'process_disabled',
      tone: 'warn',
      title: `${t.name} is disabled and turned away ${plural(t.n, 'event')} in 24 h`,
      detail: 'It has never run. Enable it if it should take these events.',
      targetKind: 'process',
      targetId: t.processId,
      action: { id: 'enable_process', label: 'Enable' },
      since: null,
    });
  }
  for (const f of input.failedPlugins) {
    out.push({
      id: `pluginload:${f.name}`,
      kind: 'plugin_unavailable',
      tone: 'error',
      title: `${f.name}: ${f.status}`,
      detail: 'The plugin failed to load.',
      targetKind: 'plugin',
      targetId: f.name,
      action: { id: 'open', label: 'Open' },
      since: null,
    });
  }
  return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
}
