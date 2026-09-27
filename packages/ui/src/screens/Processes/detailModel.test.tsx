import { describe, expect, it } from 'vitest';

import { buildFixtures } from '../../api/fixtures.js';
import { TEST_NOW } from '../../test/constants.js';
import { enableConsequence } from './detailModel.js';

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
