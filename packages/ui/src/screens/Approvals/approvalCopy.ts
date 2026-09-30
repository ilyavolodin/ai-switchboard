import type { ApprovalHistoryItem, ApprovalItem, StatusTone } from '@ai-switchboard/core/contract';

import { plural } from '../../lib/format.js';

export function ruleText(rule: string): string {
  return rule === 'always' || rule === 'none' ? rule : 'expression';
}

export function batchSummary(item: Pick<ApprovalItem, 'eventCount' | 'kind'>): string {
  if (item.kind === 'sweep') return 'sweep';
  if (item.kind === 'manual') return 'manual start';
  return plural(item.eventCount, 'event');
}

export function decisionChip(decision: ApprovalHistoryItem['decision']): {
  tone: StatusTone;
  label: string;
} {
  if (decision === 'approved') return { tone: 'ok', label: decision };
  if (decision === 'withdrawn') return { tone: 'off', label: 'withdrawn · process deleted' };
  return { tone: 'error', label: decision };
}
