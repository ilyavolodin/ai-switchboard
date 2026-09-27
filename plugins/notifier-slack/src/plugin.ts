import { definePlugin } from '@ai-switchboard/sdk';

import { slackNotifierType } from './notifier.js';

export { buildMessage, slackNotifierType } from './notifier.js';
export type { SlackSettings } from './notifier.js';

export default definePlugin({
  id: 'notifier-slack',
  displayName: 'Slack notifier',
  description: 'Posts notifications to Slack through an incoming webhook or a bot token.',
  notifiers: [slackNotifierType],
  capabilities: { network: ['hooks.slack.com', 'slack.com'] },
});
