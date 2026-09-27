import { describe, expect, it } from 'vitest';

import type { NotificationMessage, Notifier, Settings } from '@ai-switchboard/sdk';
import {
  createStubHttp,
  createTestContext,
  pluginConformanceChecks,
  runConformance,
  type StubHandler,
  type StubRequest,
} from '@ai-switchboard/sdk/testing';

import plugin, { buildMessage, slackNotifierType } from './plugin.js';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/fixture-secret';
const BOT = 'xoxb-fixture-secret';

const message: NotificationMessage = {
  on: 'error',
  severity: 'error',
  title: 'Triage run failed',
  text: 'Run for acme/api#42 ended in error',
  url: 'https://switchboard.example.com/runs/1',
  fields: { Process: 'Triage', Executor: 'Claude Routines' },
};

function setup(
  settings: Settings,
  handler: StubHandler,
): { notifier: Notifier; calls: StubRequest[] } {
  const stub = createStubHttp(handler);
  return {
    notifier: slackNotifierType.create(settings, createTestContext({ http: stub.client })),
    calls: stub.calls,
  };
}

runConformance('plugin', pluginConformanceChecks(plugin), { describe, it });

describe('slack: Block Kit message', () => {
  it('has a header, a severity word, the text, fields and a link button', () => {
    const { text, blocks } = buildMessage(message);
    expect(text).toBe('[ERROR] Triage run failed: Run for acme/api#42 ended in error');
    expect(blocks).toEqual([
      { type: 'header', text: { type: 'plain_text', text: 'Triage run failed', emoji: false } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '*ERROR* · error' }] },
      { type: 'section', text: { type: 'mrkdwn', text: 'Run for acme/api#42 ended in error' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Process*\nTriage' },
          { type: 'mrkdwn', text: '*Executor*\nClaude Routines' },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open', emoji: false },
            url: 'https://switchboard.example.com/runs/1',
            style: 'danger',
          },
        ],
      },
    ]);
  });

  it('omits the button without a url and the fields without fields', () => {
    const { blocks } = buildMessage({ on: 'ok', severity: 'info', title: 'Done', text: 'ok' });
    expect(blocks.map((b) => b.type)).toEqual(['header', 'context', 'section']);
    expect(JSON.stringify(blocks)).toContain('*INFO*');
  });

  it('escapes Slack control characters so event text cannot mention or link', () => {
    const { blocks } = buildMessage({
      ...message,
      text: 'hey <!channel> & <https://evil.example|click>',
      fields: { '<b>': '<@U123>' },
    });
    const json = JSON.stringify(blocks);
    expect(json).toContain('hey &lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;');
    expect(json).toContain('*&lt;b&gt;*\\n&lt;@U123&gt;');
  });

  it('truncates the header and splits more than ten fields', () => {
    const fields = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, `v${i}`]));
    const { blocks } = buildMessage({ ...message, title: 'x'.repeat(200), fields });
    const header = blocks[0] as { text: { text: string } };
    expect(header.text.text).toHaveLength(150);
    const sections = blocks.filter((b) => Array.isArray(b.fields));
    expect(sections.map((s) => (s.fields as unknown[]).length)).toEqual([10, 2]);
  });
});

describe('slack: webhook mode', () => {
  it('posts the message to the incoming webhook', async () => {
    const { notifier, calls } = setup({ webhookUrl: WEBHOOK }, () => ({ body: 'ok' }));
    await notifier.send(message);
    expect(calls[0]?.url.toString()).toBe(WEBHOOK);
    expect(calls[0]?.json()).toEqual(buildMessage(message));
  });

  it('throws when the webhook refuses', async () => {
    const { notifier } = setup({ webhookUrl: WEBHOOK }, () => ({
      status: 404,
      body: 'no_service',
    }));
    await expect(notifier.send(message)).rejects.toThrow(/404: no_service/);
  });

  it('health is unknown (a webhook cannot be checked without posting)', async () => {
    const { notifier, calls } = setup({ webhookUrl: WEBHOOK }, () => ({ body: 'ok' }));
    expect((await notifier.health()).status).toBe('unknown');
    expect(calls).toHaveLength(0);
  });

  it('requires a webhook url', () => {
    expect(() => slackNotifierType.create({ mode: 'webhook' }, createTestContext())).toThrow(
      /webhookUrl/,
    );
  });
});

describe('slack: bot mode', () => {
  const settings = { mode: 'bot', botToken: BOT, channel: 'C0123' };

  it('posts with chat.postMessage to the channel', async () => {
    const { notifier, calls } = setup(settings, () => ({ json: { ok: true, ts: '1.2' } }));
    await notifier.send(message);
    expect(calls[0]?.url.toString()).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${BOT}`);
    expect(calls[0]?.json()).toEqual({
      channel: 'C0123',
      ...buildMessage(message),
      unfurl_links: false,
    });
  });

  it('throws on ok:false with the Slack error', async () => {
    const { notifier } = setup(settings, () => ({ json: { ok: false, error: 'not_in_channel' } }));
    await expect(notifier.send(message)).rejects.toThrow(/not_in_channel/);
  });

  it('throws on HTTP errors, including rate limits', async () => {
    const { notifier } = setup(settings, () => ({ status: 429, headers: { 'retry-after': '3' } }));
    await expect(notifier.send(message)).rejects.toThrow(/429 \(retry after 3s\)/);
  });

  it('health calls auth.test', async () => {
    const ok = setup(settings, () => ({ json: { ok: true, team: 'Acme' } }));
    const health = await ok.notifier.health();
    expect(health).toMatchObject({ status: 'healthy', message: 'Bot token valid (Acme)' });
    expect(ok.calls[0]?.url.pathname).toBe('/api/auth.test');
    const bad = setup(settings, () => ({ json: { ok: false, error: 'invalid_auth' } }));
    expect(await bad.notifier.health()).toMatchObject({ status: 'unhealthy' });
  });

  it('requires a bot token and channel', () => {
    expect(() =>
      slackNotifierType.create({ mode: 'bot', botToken: BOT }, createTestContext()),
    ).toThrow(/channel/);
  });
});
