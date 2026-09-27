import { useState } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { AppProviders } from './AppProviders.js';
import { createQueryClient } from './queryClient.js';
import { routes } from './routes.js';

const router = createBrowserRouter(routes);

/** The application root: providers + the data router. */
export function App() {
  const [client] = useState(createQueryClient);
  return (
    <AppProviders client={client}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
