import { definePlugin } from '@ai-switchboard/sdk';

import { githubActionsExecutorType } from './executor.js';

export { githubActionsExecutorType } from './executor.js';
export type { GithubActionsSettings } from './settings.js';
export type { WorkflowInputs, WorkflowTarget } from './target.js';

export default definePlugin({
  id: 'executor-github-actions',
  displayName: 'GitHub Actions executor',
  description: 'Dispatches GitHub Actions workflows and tracks their runs, minutes and jobs.',
  executors: [githubActionsExecutorType],
  capabilities: { network: ['api.github.com'] },
});
