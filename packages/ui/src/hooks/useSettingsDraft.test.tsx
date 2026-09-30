import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { useSettingsDraft } from './useSettingsDraft.js';

function inRouter() {
  return ({ children }: { children: ReactNode }) => (
    <RouterProvider router={createMemoryRouter([{ path: '*', element: children }])} />
  );
}

describe('useSettingsDraft', () => {
  it('adopts a refetch while clean and keeps unsaved edits otherwise', () => {
    const { result, rerender } = renderHook(({ saved }) => useSettingsDraft(saved), {
      initialProps: { saved: { a: '1', b: '1' } },
      wrapper: inRouter(),
    });
    rerender({ saved: { a: '2', b: '1' } });
    expect(result.current.draft).toEqual({ a: '2', b: '1' });

    act(() => {
      result.current.set({ b: 'mine' });
    });
    rerender({ saved: { a: '3', b: '1' } });
    expect(result.current.draft).toEqual({ a: '2', b: 'mine' });

    act(() => {
      result.current.discard();
    });
    expect(result.current.draft).toEqual({ a: '3', b: '1' });
  });
});
