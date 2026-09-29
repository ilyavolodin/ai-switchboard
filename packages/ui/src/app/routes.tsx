// Detail tabs are URL segments (`/processes/:id/:tab`) so they deep-link.
import type { RouteObject } from 'react-router';

import { ChangePassword } from '../screens/ChangePassword/ChangePassword.js';
import { Login } from '../screens/Login/Login.js';
import { NoAccess } from '../screens/NoAccess/NoAccess.js';
import { AppShell } from './AppShell.js';
import { LegacyExecutorsRedirect } from './LegacyRedirect.js';
import type { RouteHandle } from './nav.js';
import { NotFound } from './NotFound.js';
import { RouteError } from './RouteError.js';
import { RouteLoading } from './RouteLoading.js';

const h = (title: string): RouteHandle => ({ title });

// Each screen is its own chunk, loaded when its route is first matched.
const activity = () =>
  import('../screens/Activity/Activity.js').then((m) => ({ Component: m.Activity }));
const trace = () => import('../screens/Activity/Trace.js').then((m) => ({ Component: m.Trace }));
const approvals = () =>
  import('../screens/Approvals/Approvals.js').then((m) => ({ Component: m.Approvals }));
const board = () => import('../screens/Board/Board.js').then((m) => ({ Component: m.Board }));
const destinationDetail = () =>
  import('../screens/Destinations/DestinationDetail.js').then((m) => ({
    Component: m.DestinationDetail,
  }));
const destinations = () =>
  import('../screens/Destinations/Destinations.js').then((m) => ({ Component: m.Destinations }));
const plugins = () =>
  import('../screens/Plugins/Plugins.js').then((m) => ({ Component: m.Plugins }));
const processDetail = () =>
  import('../screens/Processes/ProcessDetail.js').then((m) => ({ Component: m.ProcessDetail }));
const processEditor = () =>
  import('../screens/Processes/ProcessEditor.js').then((m) => ({ Component: m.ProcessEditor }));
const processes = () =>
  import('../screens/Processes/Processes.js').then((m) => ({ Component: m.Processes }));
const settings = () =>
  import('../screens/Settings/Settings.js').then((m) => ({ Component: m.Settings }));
const sourceDetail = () =>
  import('../screens/Sources/SourceDetail.js').then((m) => ({ Component: m.SourceDetail }));
const sources = () =>
  import('../screens/Sources/Sources.js').then((m) => ({ Component: m.Sources }));

export const routes: RouteObject[] = [
  { path: '/login', element: <Login />, handle: h('Sign in') },
  { path: '/no-access', element: <NoAccess />, handle: h('No access') },
  { path: '/change-password', element: <ChangePassword />, handle: h('Change password') },
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <RouteLoading />,
    children: [
      { index: true, lazy: board, handle: h('Board') },
      {
        path: 'processes',
        handle: h('Processes'),
        children: [
          { index: true, lazy: processes },
          { path: 'new', lazy: processEditor },
          { path: ':id', lazy: processDetail },
          { path: ':id/edit', lazy: processEditor },
          { path: ':id/:tab', lazy: processDetail },
        ],
      },
      {
        path: 'sources',
        handle: h('Sources'),
        children: [
          { index: true, lazy: sources },
          { path: ':id', lazy: sourceDetail },
          { path: ':id/:tab', lazy: sourceDetail },
        ],
      },
      {
        path: 'destinations',
        handle: h('Destinations'),
        children: [
          { index: true, lazy: destinations },
          { path: ':id', lazy: destinationDetail },
          { path: ':id/:tab', lazy: destinationDetail },
        ],
      },
      // Deprecated: the pre-rename paths redirect to their destination pages.
      { path: 'executors/*', element: <LegacyExecutorsRedirect /> },
      {
        path: 'activity',
        handle: h('Activity'),
        children: [
          { index: true, lazy: activity },
          { path: 'trace/:query', lazy: trace },
        ],
      },
      { path: 'approvals', lazy: approvals, handle: h('Approvals') },
      {
        path: 'plugins',
        handle: h('Plugins'),
        children: [
          { index: true, lazy: plugins },
          { path: ':tab', lazy: plugins },
        ],
      },
      {
        path: 'settings',
        handle: h('Settings'),
        children: [
          { index: true, lazy: settings },
          { path: ':tab', lazy: settings },
        ],
      },
      { path: '*', element: <NotFound />, handle: h('Not found') },
    ],
  },
];
