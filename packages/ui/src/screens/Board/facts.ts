import type { AttentionItem } from '@ai-switchboard/core/contract';

import { formatCount, formatRelative, formatWhen, toMs } from '../../lib/format.js';
import { destinationHref, processHref, sourceHref } from '../../lib/hrefs.js';
import { meterValueText } from '../../lib/meter.js';
import type { LaidOutNode } from './layout.js';

export function keyFacts(n: LaidOutNode, nowMs: number): string[] {
  if (n.kind === 'source') {
    const s = n.node;
    const last = toMs(s.lastEventAt);
    return [
      `${s.status.label}${s.enabled ? '' : ' · disabled'}${s.pluginAvailable ? '' : ' · plugin unavailable'}`,
      `${formatCount(s.events24h)} events in 24 h`,
      last != null ? `last event ${formatRelative(last, nowMs)}` : 'no events yet',
    ];
  }
  if (n.kind === 'process') {
    const p = n.node;
    const next = toMs(p.nextSweepAt);
    const last = toMs(p.lastRunAt);
    return [
      `${p.status.label}${p.awaitingApproval > 0 ? ` · ${p.awaitingApproval} awaiting approval` : ''}`,
      `${p.runs24h} runs in 24 h${last != null ? ` · last ${formatRelative(last, nowMs)}` : ''}`,
      next != null ? `next sweep ${formatWhen(next, nowMs)}` : 'no sweep scheduled',
    ];
  }
  const x = n.node;
  const meters = x.meters.map((m) => `${m.title} ${meterValueText(m)}${m.stale ? ' (stale)' : ''}`);
  return [
    `${x.status.label} · ${x.typeName}`,
    meters.length ? meters.slice(0, 2).join(' · ') : 'no meters',
    x.softHoldUntil
      ? `soft hold until ${formatWhen(toMs(x.softHoldUntil) ?? nowMs, nowMs)}`
      : `${x.meters.length} meters`,
  ];
}

const HREF = { source: sourceHref, process: processHref, destination: destinationHref } as const;

export function nodeHref(n: Pick<LaidOutNode, 'kind' | 'id'>): string {
  return HREF[n.kind](n.id);
}

export function attentionHref(item: Pick<AttentionItem, 'targetKind' | 'targetId'>): string {
  switch (item.targetKind) {
    case 'process':
    case 'source':
    case 'destination':
      return HREF[item.targetKind](item.targetId);
    case 'plugin':
      return '/plugins';
    case 'approval':
      return '/approvals';
  }
}
