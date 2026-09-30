import type { Settings } from '../../types/common.js';
import type { NotificationMessage, Notifier, NotifierType } from '../../types/notifier.js';
import type { StubHandler } from '../stubs.js';
import {
  assert,
  healthCheck,
  testContext,
  typeManifestCheck,
  type ConformanceCheck,
  type Violations,
} from './shared.js';

export interface NotifierFixtures {
  settings: Settings;
  /** Stubs the backend; the default answers 200 `{"ok":true}`. */
  http?: StubHandler;
  /** Defaults to an `error` notification with a title, text, URL and fields. */
  message?: NotificationMessage;
  /** The declared network capability; `pluginConformanceChecks` fills it from the plugin. */
  allowedHosts?: string[];
  now?: () => Date;
}

const EXAMPLE_NOTIFICATION: NotificationMessage = {
  on: 'error',
  severity: 'error',
  title: 'Run failed: Triage alerts',
  text: 'The destination answered 500.',
  url: 'https://switchboard.test/runs/1',
  fields: { process: 'Triage alerts', status: 'failed' },
};

const OK_REPLY: StubHandler = () => ({ status: 200, json: { ok: true } });

export function notifierConformanceChecks(
  type: NotifierType,
  fixtures: NotifierFixtures,
): ConformanceCheck[] {
  return notifierChecks(type, fixtures, []);
}

export function notifierChecks(
  type: NotifierType,
  fixtures: NotifierFixtures,
  violations: Violations,
): ConformanceCheck[] {
  const make = (handler: StubHandler): { notifier: Notifier; calls: () => number } => {
    const { ctx, calls } = testContext(fixtures, violations, handler);
    return { notifier: type.create(fixtures.settings, ctx), calls };
  };
  const message = fixtures.message ?? EXAMPLE_NOTIFICATION;
  return [
    typeManifestCheck({ notifiers: [type] }),
    healthCheck(() => make(fixtures.http ?? OK_REPLY).notifier),
    {
      name: 'send delivers a message with one or more requests',
      run: async () => {
        const { notifier, calls } = make(fixtures.http ?? OK_REPLY);
        await notifier.send(message);
        assert(calls() > 0, 'send made no request');
      },
    },
    {
      name: 'send rejects when the backend refuses',
      run: async () => {
        const { notifier } = make(() => ({ status: 500, body: 'unavailable' }));
        let rejected = false;
        try {
          await notifier.send(message);
        } catch {
          rejected = true;
        }
        assert(rejected, 'send resolved although the backend answered 500');
      },
    },
  ];
}
