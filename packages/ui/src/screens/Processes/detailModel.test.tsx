import { describe, expect, it } from 'vitest';

import { buildFixtures } from '../../api/fixtures.js';
import { TEST_NOW } from '../../test/constants.js';
import { deleteConsequence, enableConsequence } from './detailModel.js';

const fx = buildFixtures(TEST_NOW);
const merge = fx.processes.find((p) => p.name === 'Merge');
if (!merge) throw new Error('fixture Merge missing');
const detail = fx.processDetail(merge);

describe('enableConsequence', () => {
  it('names the parked batches with the right plural', () => {
    const text = enableConsequence({ ...detail, awaitingApproval: 2 }, false);
    expect(text).toContain('2 batches awaiting approval stay parked');
    expect(enableConsequence({ ...detail, awaitingApproval: 1 }, false)).toContain(
      '1 batch awaiting approval stays parked',
    );
  });

  it('leaves the approval clause out when nothing is waiting', () => {
    expect(enableConsequence({ ...detail, awaitingApproval: 0 }, false)).not.toContain(
      'awaiting approval',
    );
  });
});

describe('deleteConsequence', () => {
  it('names dropped batches, withdrawn approvals and what stays', () => {
    const two = deleteConsequence({ ...detail, awaitingApproval: 2 });
    expect(two).toContain('open batches are dropped, and its 2 pending approvals are withdrawn');
    expect(two).toContain('runs and events stay for the trace');
    expect(deleteConsequence({ ...detail, awaitingApproval: 1 })).toContain(
      '1 pending approval is withdrawn',
    );
    expect(deleteConsequence({ ...detail, awaitingApproval: 0 })).not.toContain('approval');
  });
});
