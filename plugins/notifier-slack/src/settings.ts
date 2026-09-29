import type { JSONSchema } from '@ai-switchboard/sdk';

export interface SlackSettings {
  mode: 'webhook' | 'bot';
  webhookUrl?: string;
  botToken?: string;
  channel?: string;
}

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'Slack notifier',
  description: 'Posts notifications to a Slack channel.',
  properties: {
    mode: {
      enum: ['webhook', 'bot'],
      default: 'webhook',
      title: 'Mode',
      description:
        'webhook: an incoming webhook bound to one channel. bot: a bot token posting with chat.postMessage.',
      'x-group': 'Delivery',
    },
    webhookUrl: {
      type: 'string',
      format: 'uri',
      pattern: '^https://',
      title: 'Incoming webhook URL',
      description: 'https://hooks.slack.com/services/… (the URL is the credential).',
      'x-secret': true,
      'x-group': 'Incoming webhook',
    },
    botToken: {
      type: 'string',
      pattern: '^xox[a-z]-',
      title: 'Bot token',
      description: 'xoxb-… token with the chat:write scope.',
      'x-secret': true,
      'x-group': 'Bot',
    },
    channel: {
      type: 'string',
      minLength: 1,
      title: 'Channel',
      description: 'Channel id (C0123…) or name (#alerts). The bot must be a member.',
      'x-group': 'Bot',
    },
  },
  allOf: [
    {
      if: { properties: { mode: { const: 'bot' } }, required: ['mode'] },
      then: { required: ['botToken', 'channel'] },
      else: { required: ['webhookUrl'] },
    },
  ],
};
