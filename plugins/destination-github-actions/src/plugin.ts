import { definePlugin } from '@ai-switchboard/sdk';

import { githubActionsDestinationType } from './destination.js';

export { githubActionsDestinationType } from './destination.js';
export type { GithubActionsSettings } from './settings.js';
export type { WorkflowInputs, WorkflowTarget } from './target.js';

export default definePlugin({
  id: 'destination-github-actions',
  displayName: 'GitHub Actions destination',
  description: 'Dispatches GitHub Actions workflows and tracks their runs, minutes and jobs.',
  destinations: [githubActionsDestinationType],
  capabilities: { network: ['api.github.com'] },
});
