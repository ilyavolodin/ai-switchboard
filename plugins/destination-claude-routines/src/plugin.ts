import { definePlugin } from '@ai-switchboard/sdk';

import { routinesDestinationType } from './destination.js';

export { routinesDestinationType } from './destination.js';
export type { RoutinesSettings, RoutinesUsageSettings } from './settings.js';
export type { RoutineInput, RoutineTarget } from './target.js';
export type { RoutineCallbackBody } from './callback.js';

export default definePlugin({
  id: 'destination-claude-routines',
  displayName: 'Claude Routines destination',
  description: 'Fires Claude Code routines and reads the seat’s usage windows.',
  destinations: [routinesDestinationType],
  capabilities: { network: ['api.anthropic.com', 'console.anthropic.com'] },
});
