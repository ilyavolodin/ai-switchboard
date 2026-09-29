import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { flatPages } from './useFlatPages.js';
import { useSearchParamState, withParam } from './useSearchParamState.js';

describe('withParam', () => {
  const base = new URLSearchParams('a=1&b=2');
  it.each([
    ['sets a value', 'c', '3', '', 'a=1&b=2&c=3'],
    ['replaces a value', 'a', '9', '', 'a=9&b=2'],
    ['drops an empty value', 'a', '', '', 'b=2'],
    ['drops null', 'b', null, '', 'a=1'],
    ['drops the fallback', 'a', 'all', 'all', 'b=2'],
  ])('%s', (_name, key, value, fallback, expected) => {
    expect(withParam(base, key, value, fallback).toString()).toBe(expected);
    expect(base.toString()).toBe('a=1&b=2');
  });
});

function SortProbe() {
  const [sort, setSort] = useSearchParamState('sort', 'activity');
  return (
    <>
      <output aria-label="sort">{sort}</output>
      <button
        type="button"
        onClick={() => {
          setSort('status');
        }}
      >
        by status
      </button>
      <button
        type="button"
        onClick={() => {
          setSort('activity');
        }}
      >
        by activity
      </button>
    </>
  );
}

describe('useSearchParamState', () => {
  it('reads the key, falls back, and writes it to the URL', async () => {
    const router = createMemoryRouter([{ path: '*', element: <SortProbe /> }], {
      initialEntries: ['/processes?q=x'],
    });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    expect(screen.getByRole('status', { name: 'sort' })).toHaveTextContent('activity');
    await user.click(screen.getByRole('button', { name: 'by status' }));
    expect(screen.getByRole('status', { name: 'sort' })).toHaveTextContent('status');
    expect(router.state.location.search).toBe('?q=x&sort=status');
    await user.click(screen.getByRole('button', { name: 'by activity' }));
    expect(router.state.location.search).toBe('?q=x');
  });
});

describe('flatPages', () => {
  it('joins the items of every page', () => {
    expect(flatPages({ pages: [{ items: [1, 2] }, { items: [3] }] })).toEqual([1, 2, 3]);
    expect(flatPages<number>(undefined)).toEqual([]);
  });
});
