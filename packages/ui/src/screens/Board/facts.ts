import type {
  AttentionItem,
  BoardExecutorNode,
  BoardProcessNode,
  BoardSourceNode,
} from '@ai-switchboard/core/contract';

import { formatCount, formatRelative, formatWhen, toMs } from '../../lib/format.js';
import { meterValueText } from '../../lib/meter.js';
import type { LaidOutNode } from './layout.js';

/** The three key facts a node's hover card shows. */
export function keyFacts(n: LaidOutNode, nowMs: number): string[] {
  if (n.kind === 'source') {
    const s = n.node as BoardSourceNode;
    const last = toMs(s.lastEventAt);
    return [
      `${s.status.label}${s.enabled ? '' : ' · disabled'}${s.pluginAvailable ? '' : ' · plugin unavailable'}`,
      `${formatCount(s.events24h)} events in 24 h`,
      last != null ? `last event ${formatRelative(last, nowMs)}` : 'no events yet',
    ];
  }
  if (n.kind === 'process') {
    const p = n.node as BoardProcessNode;
    const next = toMs(p.nextSweepAt);
    const last = toMs(p.lastRunAt);
    return [
      `${p.status.label}${p.awaitingApproval > 0 ? ` · ${p.awaitingApproval} awaiting approval` : ''}`,
      `${p.runs24h} runs in 24 h${last != null ? ` · last ${formatRelative(last, nowMs)}` : ''}`,
      next != null ? `next sweep ${formatWhen(next, nowMs)}` : 'no sweep scheduled',
    ];
  }
  const x = n.node as BoardExecutorNode;
  const meters = x.meters.map((m) => `${m.title} ${meterValueText(m)}${m.stale ? ' (stale)' : ''}`);
  return [
    `${x.status.label} · ${x.typeName}`,
    meters.length ? meters.slice(0, 2).join(' · ') : 'no meters',
    x.softHoldUntil
      ? `soft hold until ${formatWhen(toMs(x.softHoldUntil) ?? nowMs, nowMs)}`
      : `${x.meters.length} meters`,
  ];
}

/** Where clicking a node goes. */
export function nodeHref(n: Pick<LaidOutNode, 'kind' | 'id'>): string {
  const id = encodeURIComponent(n.id);
  if (n.kind === 'source') return `/sources/${id}`;
  if (n.kind === 'process') return `/processes/${id}`;
  return `/executors/${id}`;
}

/** Where an attention item's target lives. */
export function attentionHref(item: Pick<AttentionItem, 'targetKind' | 'targetId'>): string {
  const id = encodeURIComponent(item.targetId);
  switch (item.targetKind) {
    case 'process':
      return `/processes/${id}`;
    case 'source':
      return `/sources/${id}`;
    case 'executor':
      return `/executors/${id}`;
    case 'plugin':
      return '/plugins';
    case 'approval':
      return '/approvals';
  }
}
