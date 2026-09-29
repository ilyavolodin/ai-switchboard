import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { QueryBoundary } from './QueryBoundary.js';

const query = <T,>(over: Partial<Parameters<typeof QueryBoundary<T>>[0]['query']>) => ({
  data: undefined,
  isPending: false,
  isError: false,
  error: null,
  refetch: vi.fn(() => Promise.resolve()),
  ...over,
});

const show = (q: ReturnType<typeof query<string[]>>) =>
  render(
    <QueryBoundary
      query={q}
      errorTitle="Things could not load"
      pending={<p>loading</p>}
      empty={<p>nothing yet</p>}
    >
      {(list) => <p>{list.join(', ')}</p>}
    </QueryBoundary>,
  );

describe('QueryBoundary', () => {
  it('shows the pending state', () => {
    show(query({ isPending: true }));
    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('shows the error with Retry, which refetches', async () => {
    const q = query<string[]>({ isError: true, error: new Error('database down') });
    show(q);
    expect(screen.getByRole('alert')).toHaveTextContent('Things could not load — database down');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(q.refetch).toHaveBeenCalled();
  });

  it('shows the empty state for an empty list, and the data otherwise', () => {
    const { unmount } = show(query({ data: [] }));
    expect(screen.getByText('nothing yet')).toBeInTheDocument();
    unmount();
    show(query({ data: ['a', 'b'] }));
    expect(screen.getByText('a, b')).toBeInTheDocument();
  });
});
