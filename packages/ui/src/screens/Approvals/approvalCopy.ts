/** Copy helpers for the Approvals screen. */
import type { ApprovalItem } from '@ai-switchboard/core/contract';

/** "always", or "expression" for a JSONata rule (the full text is shown on the card). */
export function ruleText(rule: string): string {
  return rule === 'always' || rule === 'none' ? rule : 'expression';
}

/** "2 events · event batch", "sweep", "manual start". */
export function batchSummary(item: Pick<ApprovalItem, 'eventCount' | 'kind'>): string {
  if (item.kind === 'sweep') return 'sweep';
  if (item.kind === 'manual') return 'manual start';
  return `${item.eventCount} ${item.eventCount === 1 ? 'event' : 'events'}`;
}
