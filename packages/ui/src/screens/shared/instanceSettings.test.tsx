import type { SourceCapsDTO } from '@ai-switchboard/core/contract';
import { describe, expect, it } from 'vitest';

import {
  editableCaps,
  instanceChangeCount,
  type InstanceSettingsDraft,
} from './instanceSettings.js';

describe('instanceChangeCount', () => {
  const saved: InstanceSettingsDraft<SourceCapsDTO> = {
    name: 'Webhook',
    settings: { verification: 'none', path: { a: 1, b: 2 } },
    caps: { eventCapPerHour: 60, unauthenticated: true },
  };

  it('ignores key order, undefined keys and core-derived caps', () => {
    expect(
      instanceChangeCount(
        {
          name: 'Webhook',
          settings: { path: { b: 2, a: 1 }, verification: 'none', extra: undefined },
          caps: { eventCapPerHour: 60, eventCapPerDay: undefined },
        },
        saved,
      ),
    ).toBe(0);
  });

  it('counts each changed part once', () => {
    expect(
      instanceChangeCount(
        { name: 'Hook', settings: { verification: 'hmac' }, caps: { eventCapPerHour: 5 } },
        saved,
      ),
    ).toBe(3);
  });
});

describe('editableCaps', () => {
  it('drops undefined and derived fields', () => {
    expect(
      editableCaps({ eventCapPerHour: 1, eventCapPerDay: undefined, unauthenticated: true }),
    ).toEqual({
      eventCapPerHour: 1,
    });
  });
});
