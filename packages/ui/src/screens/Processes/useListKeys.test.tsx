import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useListKeys } from './useListKeys.js';

describe('useListKeys', () => {
  it('keeps the keys of the other items when one is removed', () => {
    const { result, rerender } = renderHook(({ n }) => useListKeys(n), {
      initialProps: { n: 3 },
    });
    const [first, , third] = result.current.keys;
    act(() => {
      result.current.removed(1);
    });
    rerender({ n: 2 });
    expect(result.current.keys).toEqual([first, third]);
    act(() => {
      result.current.added();
    });
    rerender({ n: 3 });
    expect(result.current.keys.slice(0, 2)).toEqual([first, third]);
    expect(new Set(result.current.keys).size).toBe(3);
  });
});
