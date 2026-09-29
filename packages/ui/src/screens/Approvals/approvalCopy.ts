import type { ApprovalItem } from '@ai-switchboard/core/contract';

export function ruleText(rule: string): string {
  return rule === 'always' || rule === 'none' ? rule : 'expression';
}

export function batchSummary(item: Pick<ApprovalItem, 'eventCount' | 'kind'>): string {
  if (item.kind === 'sweep') return 'sweep';
  if (item.kind === 'manual') return 'manual start';
  return `${item.eventCount} ${item.eventCount === 1 ? 'event' : 'events'}`;
}
