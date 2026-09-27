import { describe, expect, it } from 'vitest';

import { idFilterOptions } from './filters.js';

describe('idFilterOptions', () => {
  const items = [{ id: 'a', name: 'Alpha' }];

  it('lists the items and adds an unknown current id as "(not found)"', () => {
    expect(idFilterOptions(items, 'gone')).toEqual([
      { value: 'a', label: 'Alpha' },
      { value: 'gone', label: 'gone (not found)' },
    ]);
  });

  it('adds nothing for a known id, no filter, or while the list is still loading', () => {
    expect(idFilterOptions(items, 'a')).toHaveLength(1);
    expect(idFilterOptions(items, undefined)).toHaveLength(1);
    expect(idFilterOptions(undefined, 'gone')).toEqual([]);
  });
});
