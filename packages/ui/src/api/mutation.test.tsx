import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildFixtures } from './fixtures.js';
import { useRunProcess } from './hooks/processes.js';
import { createMockApi } from './mockApi.js';
import { TEST_NOW } from '../test/constants.js';

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe('useApiMutation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes only the route’s own params out of the body', async () => {
    const api = createMockApi({ fixtures: buildFixtures(TEST_NOW) });
    vi.stubGlobal('fetch', api.fetch);
    const { result } = renderHook(() => useRunProcess(), { wrapper });
    result.current.mutate({ id: 'p-autofix', reason: 'retry', batchId: 'b-9' });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(api.callsTo('POST /processes/p-autofix/run')[0]?.body).toEqual({
      reason: 'retry',
      batchId: 'b-9',
    });
  });
});
