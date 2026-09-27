import { definePlugin } from '@ai-switchboard/sdk';

import { routinesExecutorType } from './executor.js';

export { routinesExecutorType } from './executor.js';
export type { RoutinesSettings, RoutinesUsageSettings } from './settings.js';
export type { RoutineInput, RoutineTarget } from './target.js';
export type { RoutineCallbackBody } from './callback.js';

export default definePlugin({
  id: 'executor-claude-routines',
  displayName: 'Claude Routines executor',
  description: 'Fires Claude Code routines and reads the seat’s usage windows.',
  executors: [routinesExecutorType],
  capabilities: { network: ['api.anthropic.com', 'console.anthropic.com'] },
});
