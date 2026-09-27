/**
 * THE route table. Every screen in the IA has a path here; screens that are not built yet render
 * `<ComingSoon>`. To add a screen, replace its `element` (keep the path and `handle.title`, which
 * the top bar shows). Detail tabs are URL segments (`/processes/:id/:tab`) so they deep-link.
 */
import type { RouteObject } from 'react-router';

import { Activity } from '../screens/Activity/Activity.js';
import { Trace } from '../screens/Activity/Trace.js';
import { Approvals } from '../screens/Approvals/Approvals.js';
import { Board } from '../screens/Board/Board.js';
import { ExecutorDetail } from '../screens/Executors/ExecutorDetail.js';
import { Executors } from '../screens/Executors/Executors.js';
import { Login } from '../screens/Login/Login.js';
import { NoAccess } from '../screens/NoAccess/NoAccess.js';
import { Plugins } from '../screens/Plugins/Plugins.js';
import { ProcessDetail } from '../screens/Processes/ProcessDetail.js';
import { ProcessEditor } from '../screens/Processes/ProcessEditor.js';
import { Processes } from '../screens/Processes/Processes.js';
import { Settings } from '../screens/Settings/Settings.js';
import { SourceDetail } from '../screens/Sources/SourceDetail.js';
import { Sources } from '../screens/Sources/Sources.js';
import { AppShell } from './AppShell.js';
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
          { index: true, element: <Processes /> },
          { path: 'new', element: <ProcessEditor /> },
          { path: ':id', element: <ProcessDetail /> },
          { path: ':id/edit', element: <ProcessEditor /> },
          { path: ':id/:tab', element: <ProcessDetail /> },
        ],
      },
      {
        path: 'sources',
        handle: h('Sources'),
        children: [
          { index: true, element: <Sources /> },
          { path: ':id', element: <SourceDetail /> },
          { path: ':id/:tab', element: <SourceDetail /> },
        ],
      },
      {
        path: 'executors',
        handle: h('Executors'),
        children: [
          { index: true, element: <Executors /> },
          { path: ':id', element: <ExecutorDetail /> },
          { path: ':id/:tab', element: <ExecutorDetail /> },
        ],
      },
      {
        path: 'activity',
        handle: h('Activity'),
        children: [
          { index: true, element: <Activity /> },
          { path: 'trace/:query', element: <Trace /> },
        ],
      },
      { path: 'approvals', element: <Approvals />, handle: h('Approvals') },
      {
        path: 'plugins',
        handle: h('Plugins'),
        children: [
          { index: true, element: <Plugins /> },
          { path: ':tab', element: <Plugins /> },
        ],
      },
      {
        path: 'settings',
        handle: h('Settings'),
        children: [
          { index: true, element: <Settings /> },
          { path: ':tab', element: <Settings /> },
        ],
      },
      { path: '*', element: <NotFound />, handle: h('Not found') },
    ],
  },
];
