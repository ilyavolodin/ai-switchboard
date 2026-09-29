import { describe, expect, it } from 'vitest';

import { batchSummary, decisionChip, ruleText } from './approvalCopy.js';

describe('approvalCopy', () => {
  it.each([
    ['always', 'always'],
    ['none', 'none'],
    ['$count(events) > 5', 'expression'],
  ])('rule %j', (rule, text) => {
    expect(ruleText(rule)).toBe(text);
  });

  it.each([
    [{ kind: 'sweep', eventCount: 0 }, 'sweep'],
    [{ kind: 'manual', eventCount: 0 }, 'manual start'],
    [{ kind: 'event', eventCount: 1 }, '1 event'],
    [{ kind: 'event', eventCount: 3 }, '3 events'],
  ] as const)('batch %j', (item, text) => {
    expect(batchSummary(item)).toBe(text);
  });

  it.each([
    ['approved', { tone: 'ok', label: 'approved' }],
    ['rejected', { tone: 'error', label: 'rejected' }],
    ['withdrawn', { tone: 'off', label: 'withdrawn · process deleted' }],
  ] as const)('decision %s', (decision, chip) => {
    expect(decisionChip(decision)).toEqual(chip);
  });
});
