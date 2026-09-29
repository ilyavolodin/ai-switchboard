import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ReasonProvider } from '../components/ReasonProvider.js';
import { ToastProvider } from '../components/ToastProvider.js';

/** Everything above a screen except the router and the session; tests wrap components in it too. */
export function AppProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReasonProvider>{children}</ReasonProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
