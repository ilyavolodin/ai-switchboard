import { describe, expect, it } from 'vitest';

import {
  verifyHmac,
  type NotificationMessage,
  type Notifier,
  type Settings,
} from '@ai-switchboard/sdk';
import {
  createStubHttp,
  createTestContext,
  pluginConformanceChecks,
  runConformance,
  type StubHandler,
  type StubRequest,
} from '@ai-switchboard/sdk/testing';

import plugin, { webhookNotifierType } from './plugin.js';

const SECRET = 'fixture-secret-signing-0001';
const URL_ = 'https://alerts.example.com/switchboard';

const message: NotificationMessage = {
  on: 'system',
  severity: 'warning',
  title: 'Breaker opened',
  text: 'Process Triage failed 5 times',
  fields: { process: 'Triage' },
};

function setup(
  settings: Settings,
  handler: StubHandler = () => ({ status: 204 }),
): {
  notifier: Notifier;
  calls: StubRequest[];
} {
  const stub = createStubHttp(handler);
  return {
    notifier: webhookNotifierType.create(settings, createTestContext({ http: stub.client })),
    calls: stub.calls,
  };
}

runConformance(
  'webhook notifier plugin',
  pluginConformanceChecks(plugin, {
    notifiers: {
      [webhookNotifierType.id]: {
        settings: { url: URL_, secret: SECRET },
        http: () => ({ status: 204 }),
        message,
      },
    },
  }),
  { describe, it },
);

describe('webhook notifier', () => {
  it('uses the id webhook', () => {
    expect(webhookNotifierType.id).toBe('webhook');
  });

  it('POSTs the notification as JSON', async () => {
    const { notifier, calls } = setup({ url: URL_, headers: { 'X-Env': 'prod' } });
    await notifier.send(message);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.toString()).toBe(URL_);
    expect(calls[0]?.json()).toEqual(message);
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.headers['x-env']).toBe('prod');
    expect(calls[0]?.headers['x-switchboard-signature']).toBeUndefined();
  });

  it('signs the raw body when a secret is set', async () => {
    const { notifier, calls } = setup({ url: URL_, secret: SECRET });
    await notifier.send(message);
    const call = calls[0];
    expect(
      verifyHmac({
        secret: SECRET,
        payload: call?.body ?? '',
        signature: call?.headers['x-switchboard-signature'],
        prefix: 'sha256=',
      }),
    ).toBe(true);
  });

  it('a configured header cannot override the signature or content type', async () => {
    const { notifier, calls } = setup({
      url: URL_,
      secret: SECRET,
      headers: { 'X-Switchboard-Signature': 'forged', 'Content-Type': 'text/plain' },
    });
    await notifier.send(message);
    expect(calls[0]?.headers['x-switchboard-signature']).not.toBe('forged');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it.each([400, 404, 500, 503])('throws on %i', async (status) => {
    const { notifier } = setup({ url: URL_ }, () => ({ status, body: 'nope' }));
    await expect(notifier.send(message)).rejects.toThrow(new RegExp(`${status}: nope`));
  });

  it('lets network failures surface', async () => {
    const { notifier } = setup({ url: URL_ }, () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    });
    await expect(notifier.send(message)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('health is unknown', async () => {
    expect((await setup({ url: URL_ }).notifier.health()).status).toBe('unknown');
  });

  it('requires a url', () => {
    expect(() => webhookNotifierType.create({}, createTestContext())).toThrow(/url/);
  });
});
