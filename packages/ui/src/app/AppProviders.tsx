import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ReasonProvider } from '../components/ReasonProvider.js';
import { ToastProvider } from '../components/ToastProvider.js';

/**
 * Everything a screen needs above it except the router and the session: TanStack Query, toasts
 * and the reason prompt. Tests wrap components in this too (see `test/render.tsx`).
 */
export function AppProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReasonProvider>{children}</ReasonProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
