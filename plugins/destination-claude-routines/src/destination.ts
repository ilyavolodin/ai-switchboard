import {
  asObject,
  asString,
  checkHealth,
  parseDefinitive,
  tryJson,
  withSettings,
  type Destination,
  type DestinationType,
  type InvokeResult,
  type JsonObject,
  type PluginContext,
  type RunHandle,
} from '@ai-switchboard/sdk';

import { createApi, refusal } from './api.js';
import { verifyRoutineCallback } from './callback.js';
import { createSeatMeters } from './meters.js';
import {
  METERS,
  USAGE_DIMENSIONS,
  metersFor,
  settingsSchema,
  type RoutinesSettings,
} from './settings.js';
import {
  inputSchema,
  targetSchema,
  withTrailer,
  type RoutineInput,
  type RoutineTarget,
} from './target.js';

function readTarget(target: unknown): RoutineTarget {
  return parseDefinitive<RoutineTarget>(targetSchema, target, 'routine target');
}

function readInput(input: unknown): RoutineInput {
  return parseDefinitive<RoutineInput>(inputSchema, input, 'routine input');
}

function firstString(record: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** Tolerates `{ id, session_url }` as well as `claude_code_session_*` and nested `session` shapes. */
function sessionOf(body: unknown): { externalId?: string; externalUrl?: string } {
  const record = asObject(body);
  if (!record) return {};
  const nested = asObject(record.session);
  let externalId: string | undefined;
  let externalUrl: string | undefined;
  for (const source of nested ? [record, nested] : [record]) {
    externalId ??= firstString(source, ['claude_code_session_id', 'session_id', 'id']);
    const url = firstString(source, ['claude_code_session_url', 'session_url', 'url']);
    if (url?.startsWith('https://')) externalUrl ??= url;
  }
  return {
    ...(externalId !== undefined ? { externalId } : {}),
    ...(externalUrl !== undefined ? { externalUrl } : {}),
  };
}

function createRoutinesDestination(settings: RoutinesSettings, ctx: PluginContext): Destination {
  const api = createApi(ctx.http, settings);
  const seat = createSeatMeters(settings.usage, api, ctx);

  return {
    async invoke(rawTarget: unknown, rawInput: unknown, run: RunHandle): Promise<InvokeResult> {
      const target = readTarget(rawTarget);
      const input = readInput(rawInput);
      const res = await api.fire(target.routineId, withTrailer(input.text, run));
      if (!res.ok) return refusal(res, ctx.now());
      return { status: 'started', ...sessionOf(tryJson(res)) };
    },

    verifyCallback: (req) => verifyRoutineCallback(req, settings.callbackSecret),

    readMeters: () => seat.read(),

    health: () =>
      checkHealth(ctx, async () => {
        const problem = await seat.problem();
        return problem !== undefined
          ? { status: 'unhealthy', message: problem }
          : {
              status: 'unknown',
              message:
                'The Routines API has no read-only call to check a trigger token; the first run will tell.',
            };
      }),
  };
}

export const routinesDestinationType: DestinationType = {
  id: 'claude-routines',
  displayName: 'Claude Routines',
  icon: 'run',
  description:
    "Fires a Claude Code routine through its API trigger. The routine's completion step posts a signed callback.",
  settingsSchema,
  targetSchema,
  inputSchema,
  examples: [
    {
      target: { routineId: 'trig_01ABCDEF' },
      input: { text: 'mode: event\nrepository: acme/api\nissue: 42' },
    },
  ],
  // The Routines API has no run listing, so a run can only be settled by its callback.
  tracking: 'callback',
  idempotentInvoke: false,
  // One fire request, bounded by the HttpClient's 30 s timeout.
  invokeTimeoutSeconds: 60,
  usage: USAGE_DIMENSIONS,
  meters: METERS,
  metersFor,
  create: withSettings(settingsSchema, 'claude-routines settings', createRoutinesDestination),
};
