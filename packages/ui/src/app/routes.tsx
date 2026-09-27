/**
 * THE route table. Every screen in the IA has a path here; screens that are not built yet render
 * `<ComingSoon>`. To add a screen, replace its `element` (keep the path and `handle.title`, which
 * the top bar shows). Detail tabs are URL segments (`/processes/:id/:tab`) so they deep-link.
 */
import type { RouteObject } from 'react-router';

import { Board } from '../screens/Board/Board.js';
import { Login } from '../screens/Login/Login.js';
import { NoAccess } from '../screens/NoAccess/NoAccess.js';
import { AppShell } from './AppShell.js';
import { ComingSoon } from './ComingSoon.js';
import type { RouteHandle } from './nav.js';
import { NotFound } from './NotFound.js';
import { RouteError } from './RouteError.js';

const h = (title: string): RouteHandle => ({ title });

export const routes: RouteObject[] = [
  { path: '/login', element: <Login />, handle: h('Sign in') },
  { path: '/no-access', element: <NoAccess />, handle: h('No access') },
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Board />, handle: h('Board') },
      {
        path: 'processes',
        handle: h('Processes'),
        children: [
          { index: true, element: <ComingSoon screen="Processes" /> },
          { path: 'new', element: <ComingSoon screen="New process" /> },
          { path: ':id', element: <ComingSoon screen="Process" /> },
          { path: ':id/edit', element: <ComingSoon screen="Process editor" /> },
          { path: ':id/:tab', element: <ComingSoon screen="Process" /> },
        ],
      },
      {
        path: 'sources',
        handle: h('Sources'),
        children: [
          { index: true, element: <ComingSoon screen="Sources" /> },
          { path: ':id', element: <ComingSoon screen="Source" /> },
          { path: ':id/:tab', element: <ComingSoon screen="Source" /> },
        ],
      },
      {
        path: 'executors',
        handle: h('Executors'),
        children: [
          { index: true, element: <ComingSoon screen="Executors" /> },
          { path: ':id', element: <ComingSoon screen="Executor" /> },
          { path: ':id/:tab', element: <ComingSoon screen="Executor" /> },
        ],
      },
      {
        path: 'activity',
        handle: h('Activity'),
        children: [
          { index: true, element: <ComingSoon screen="Activity" /> },
          { path: 'trace/:query', element: <ComingSoon screen="Trace" /> },
        ],
      },
      { path: 'approvals', element: <ComingSoon screen="Approvals" />, handle: h('Approvals') },
      {
        path: 'plugins',
        handle: h('Plugins'),
        children: [
          { index: true, element: <ComingSoon screen="Plugins" /> },
          { path: ':tab', element: <ComingSoon screen="Plugins" /> },
        ],
      },
      {
        path: 'settings',
        handle: h('Settings'),
        children: [
          { index: true, element: <ComingSoon screen="Settings" /> },
          { path: ':tab', element: <ComingSoon screen="Settings" /> },
        ],
      },
      { path: '*', element: <NotFound />, handle: h('Not found') },
    ],
  },
];
