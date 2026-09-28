import {
  invokeErrorForStatus,
  parseRetryAfter,
  type Destination,
  type DestinationType,
  type HttpResponse,
  type InvokeResult,
  type PluginContext,
  type RunHandle,
} from '@ai-switchboard/sdk';

import { verifyRoutineCallback } from './callback.js';
import { createSeatMeters } from './meters.js';
import {
  METERS,
  USAGE_DIMENSIONS,
  metersFor,
  readSettings,
  settingsSchema,
  type RoutinesSettings,
} from './settings.js';
import { inputSchema, readInput, readTarget, targetSchema, withTrailer } from './target.js';

export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_RETRY_AFTER_SECONDS = 60;

function jsonBody(res: HttpResponse): unknown {
  try {
    return res.json();
  } catch {
    return undefined;
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Tolerates `{ id, session_url }` as well as `claude_code_session_*` and nested `session` shapes. */
export function sessionOf(body: unknown): { externalId?: string; externalUrl?: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const nested = record.session;
  const sources =
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? [record, nested as Record<string, unknown>]
      : [record];
  let externalId: string | undefined;
  let externalUrl: string | undefined;
  for (const source of sources) {
    externalId ??= firstString(source, ['claude_code_session_id', 'session_id', 'id']);
    const url = firstString(source, ['claude_code_session_url', 'session_url', 'url']);
    if (url?.startsWith('https://')) externalUrl ??= url;
  }
  return {
    ...(externalId !== undefined ? { externalId } : {}),
    ...(externalUrl !== undefined ? { externalUrl } : {}),
  };
}

/** Anthropic errors look like `{ type: 'error', error: { type, message } }`. */
export function errorMessage(res: HttpResponse): string {
  const body = jsonBody(res);
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const err = body.error;
    if (err !== null && typeof err === 'object' && 'message' in err) {
      const message = err.message;
      if (typeof message === 'string') return message;
    }
    if (typeof err === 'string') return err;
  }
  return res.text().slice(0, 200);
}

/** Map a refused fire call; returns a result for 429 and held states, throws for the rest. */
export function refusal(res: HttpResponse, now: Date): InvokeResult {
  const message = errorMessage(res);
  const retryAfter = parseRetryAfter(res.headers['retry-after'], now);
  const status = res.status;
  if (status === 429) {
    return {
      status: 'failed',
      retryAfterSeconds: retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS,
      errors: [`Routines API rate limit: ${message}`],
    };
  }
  if ((status === 400 || status === 409) && /\bpaused\b/i.test(message)) {
    return { status: 'held', reason: 'paused' };
  }
  if ((status === 400 || status === 409) && /\bdisabled\b/i.test(message)) {
    return { status: 'held', reason: 'disabled' };
  }
  const text = `Routines API answered ${status}: ${message}`;
  // 529 is Anthropic's "overloaded": the request was not processed, so it is as safe to retry as a 503.
  if (status === 503 || status === 529) {
    throw invokeErrorForStatus(
      503,
      text,
      retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {},
    );
  }
  throw invokeErrorForStatus(status, text);
}

function createRoutinesDestination(settings: RoutinesSettings, ctx: PluginContext): Destination {
  const seat = createSeatMeters(settings.usage, ctx);
  const base = settings.apiBaseUrl.replace(/\/+$/, '');

  return {
    async invoke(rawTarget: unknown, rawInput: unknown, run: RunHandle): Promise<InvokeResult> {
      const target = readTarget(rawTarget);
      const input = readInput(rawInput);
      const res = await ctx.http.post(
        `${base}/v1/claude_code/routines/${encodeURIComponent(target.routineId)}/fire`,
        {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${settings.token}`,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': settings.betaHeader,
          },
          json: { text: withTrailer(input.text, run) },
        },
      );
      if (!res.ok) return refusal(res, ctx.now());
      return { status: 'started', ...sessionOf(jsonBody(res)) };
    },

    verifyCallback: (req) => verifyRoutineCallback(req, settings.callbackSecret),

    readMeters: () => seat.read(),

    health: () =>
      Promise.resolve({
        status: 'unknown',
        message:
          'The Routines API has no read-only call to check a trigger token; the first run will tell.',
        checkedAt: ctx.now().toISOString(),
      }),
  };
}

/** Fires a Claude Code routine; its completion step posts a signed callback with token usage. */
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
  create: (settings, ctx) => createRoutinesDestination(readSettings(settings), ctx),
};
