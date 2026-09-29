import {
  checkHealth,
  tryJson,
  withSettings,
  type Health,
  type NotificationMessage,
  type Notifier,
  type NotifierType,
  type PluginContext,
} from '@ai-switchboard/sdk';

import { settingsSchema, type SlackSettings } from './settings.js';

export const SLACK_API = 'https://slack.com/api';

export class SlackError extends Error {
  override readonly name = 'SlackError';
}

const HEADER_MAX = 150;
const SECTION_MAX = 3000;
const FIELD_MAX = 2000;
const FIELDS_PER_SECTION = 10;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Slack control characters; escaping keeps event text from injecting mentions or links. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SEVERITY_WORD: Record<NotificationMessage['severity'], string> = {
  info: 'INFO',
  warning: 'WARNING',
  error: 'ERROR',
};

type Block = Record<string, unknown>;

export function buildMessage(message: NotificationMessage): { text: string; blocks: Block[] } {
  const severity = SEVERITY_WORD[message.severity];
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncate(message.title, HEADER_MAX), emoji: false },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*${severity}* · ${escapeMrkdwn(message.on)}` }],
    },
  ];
  if (message.text.trim() !== '') {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(escapeMrkdwn(message.text), SECTION_MAX) },
    });
  }
  const fields = Object.entries(message.fields ?? {}).map(([key, value]) => ({
    type: 'mrkdwn',
    text: truncate(`*${escapeMrkdwn(key)}*\n${escapeMrkdwn(value)}`, FIELD_MAX),
  }));
  for (let i = 0; i < fields.length; i += FIELDS_PER_SECTION) {
    blocks.push({ type: 'section', fields: fields.slice(i, i + FIELDS_PER_SECTION) });
  }
  if (message.url !== undefined) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open', emoji: false },
          url: message.url,
          ...(message.severity === 'error' ? { style: 'danger' } : {}),
        },
      ],
    });
  }
  // The fallback text shows in notifications and on clients that cannot render blocks.
  const text = truncate(`[${severity}] ${message.title}: ${message.text}`, SECTION_MAX);
  return { text, blocks };
}

function createSlackNotifier(settings: SlackSettings, ctx: PluginContext): Notifier {
  async function postApi(method: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await ctx.http.post(`${SLACK_API}/${method}`, {
      headers: { authorization: `Bearer ${settings.botToken ?? ''}` },
      json: body,
    });
    if (!res.ok) {
      const retry = res.headers['retry-after'];
      throw new SlackError(
        `Slack ${method} answered ${res.status}${retry !== undefined ? ` (retry after ${retry}s)` : ''}`,
      );
    }
    const parsed = tryJson(res);
    if (parsed === undefined) throw new SlackError(`Slack ${method} returned a non-JSON body`);
    const record = (parsed ?? {}) as Record<string, unknown>;
    if (record.ok !== true) {
      const error = typeof record.error === 'string' ? record.error : 'unknown_error';
      throw new SlackError(`Slack ${method} failed: ${error}`);
    }
    return record;
  }

  return {
    async send(message: NotificationMessage): Promise<void> {
      const payload = buildMessage(message);
      if (settings.mode === 'bot') {
        await postApi('chat.postMessage', {
          channel: settings.channel,
          ...payload,
          unfurl_links: false,
        });
        return;
      }
      const res = await ctx.http.post(settings.webhookUrl ?? '', { json: payload });
      if (!res.ok) {
        // Incoming webhooks answer with a plain-text reason such as `no_service` or `invalid_blocks`.
        throw new SlackError(`Slack webhook answered ${res.status}: ${res.text().slice(0, 200)}`);
      }
    },

    health: (): Promise<Health> =>
      checkHealth(ctx, async () => {
        if (settings.mode === 'webhook') {
          return {
            status: 'unknown',
            message: 'An incoming webhook cannot be checked without posting a message.',
          };
        }
        const auth = await postApi('auth.test', {});
        const team = typeof auth.team === 'string' ? ` (${auth.team})` : '';
        return { status: 'healthy', message: `Bot token valid${team}` };
      }),
  };
}

export const slackNotifierType: NotifierType = {
  id: 'slack',
  displayName: 'Slack',
  icon: 'alert',
  description: 'Posts run outcomes and system alerts to Slack with Block Kit.',
  settingsSchema,
  create: withSettings(settingsSchema, 'slack settings', createSlackNotifier),
};
