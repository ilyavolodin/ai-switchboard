import {
  InvokeError,
  validateAgainst,
  withSettings,
  type DestinationType,
  type MeterSpec,
  type PluginContext,
} from '@ai-switchboard/sdk';

import { settingsSchema, type LogSettings } from './settings.js';
import { inputSchema, targetSchema, type LogTarget } from './target.js';

const meter: MeterSpec = {
  id: 'hourly_runs',
  title: 'Hourly runs',
  kind: 'window',
  unit: '%',
  primary: true,
};

const STATE_KEY = 'invocations';
const HOUR_MS = 3_600_000;

function parseTarget(target: unknown): LogTarget {
  const copy = structuredClone(target ?? {}) as Record<string, unknown>;
  const check = validateAgainst(targetSchema, copy);
  if (!check.valid)
    throw new InvokeError(`Invalid target: ${check.errors.join('; ')}`, {
      definitive: true,
      sent: false,
    });
  return copy as unknown as LogTarget;
}

/** JSON.stringify returns undefined for undefined, despite its declared type. */
function toJson(value: unknown): string {
  return value === undefined ? 'null' : JSON.stringify(value);
}

function preview(value: unknown, max: number): string {
  const text = toJson(value);
  return text.length > max ? `${text.slice(0, max)}… (${text.length} bytes)` : text;
}

async function recordInvocation(ctx: PluginContext, now: Date): Promise<number[]> {
  const cutoff = now.getTime() - HOUR_MS;
  const previous = (await ctx.state.get<number[]>(STATE_KEY)) ?? [];
  const recent = [...previous.filter((t) => t > cutoff), now.getTime()];
  await ctx.state.set(STATE_KEY, recent);
  return recent;
}

export function invokeTimeoutFor(target: unknown): number {
  const delayMs =
    target !== null && typeof target === 'object'
      ? (target as { delayMs?: unknown }).delayMs
      : undefined;
  const delay = typeof delayMs === 'number' && Number.isFinite(delayMs) ? delayMs / 1000 : 0;
  return Math.max(30, Math.ceil(delay) + 10);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const logDestinationType: DestinationType = {
  id: 'log',
  displayName: 'Log (test destination)',
  icon: 'activity',
  description:
    'Writes every invocation to the server log and answers with the input. Simulates outcomes, delays and a meter, so a process can be tried out without a real backend.',
  settingsSchema,
  targetSchema,
  inputSchema,
  examples: [
    {
      target: { label: 'demo', outcome: 'ok' },
      input: { mode: 'event', artifacts: [{ kind: 'demo', id: '1' }] },
    },
    { target: { outcome: 'error' }, input: { mode: 'sweep' } },
  ],
  tracking: 'sync',
  // Logging twice is harmless, so a lost response may be retried.
  idempotentInvoke: true,
  // The simulated delay (at most 30 s) plus room to answer.
  invokeTimeoutSeconds: 30,
  invokeTimeoutFor: (target) => invokeTimeoutFor(target),
  usage: [
    { id: 'invocations', title: 'Invocations', unit: 'count', aggregate: 'sum', budgetable: true },
    { id: 'input_bytes', title: 'Input size', unit: 'bytes', aggregate: 'sum', budgetable: true },
  ],
  meters: [],
  metersFor: (settings) => (typeof settings.hourlyLimit === 'number' ? [meter] : []),
  actions: [
    {
      id: 'log',
      title: 'Write a log line',
      description: 'A before/after step that writes its message to the server log.',
      argsSchema: {
        type: 'object',
        required: ['message'],
        properties: { message: { type: 'string', title: 'Message' } },
      },
      describe: 'Log "{{message}}"',
      // Writing the line again is harmless.
      idempotent: true,
    },
  ],
  create: withSettings(settingsSchema, 'log destination settings', (settings: LogSettings, ctx) => {
    const log = (message: string, fields: Record<string, unknown>): void =>
      ctx.logger[settings.level](message, fields);
    return {
      async invoke(rawTarget, input, run) {
        const target = parseTarget(rawTarget);
        const now = ctx.now();
        log('log destination invocation', {
          run_id: run.id,
          process: run.processName,
          mode: run.mode,
          dry_run: run.dryRun,
          label: target.label,
          outcome: target.outcome,
          ...(settings.logInput ? { input: preview(input, settings.maxLoggedBytes) } : {}),
        });
        if (target.delayMs > 0) await sleep(target.delayMs);
        if (!run.dryRun) await recordInvocation(ctx, now);
        const inputBytes = Buffer.byteLength(toJson(input));
        const usage = { invocations: 1, input_bytes: inputBytes };
        switch (target.outcome) {
          case 'ok':
            return {
              status: 'completed',
              externalId: run.id,
              result: { logged: true, runId: run.id, label: target.label ?? null, input },
              usage,
            };
          case 'error':
            return {
              status: 'failed',
              errors: ['simulated error from the log destination'],
              usage,
            };
          case 'failed':
            throw new InvokeError('simulated definitive refusal from the log destination', {
              status: 400,
              definitive: true,
            });
          case 'held':
            return { status: 'held', reason: 'paused' };
          case 'rate_limited':
            return {
              status: 'failed',
              retryAfterSeconds: target.retryAfterSeconds,
              errors: ['simulated rate limit'],
            };
        }
      },
      async readMeters() {
        if (settings.hourlyLimit === undefined) return [];
        const now = ctx.now();
        const cutoff = now.getTime() - HOUR_MS;
        const recent = ((await ctx.state.get<number[]>(STATE_KEY)) ?? []).filter((t) => t > cutoff);
        const oldest = recent[0];
        return [
          {
            id: meter.id,
            used: recent.length,
            limit: settings.hourlyLimit,
            utilization: Math.min(100, (recent.length / settings.hourlyLimit) * 100),
            resetsAt: new Date((oldest ?? now.getTime()) + HOUR_MS).toISOString(),
            observedAt: now.toISOString(),
          },
        ];
      },
      act(action, args) {
        if (action !== 'log')
          return Promise.resolve({ ok: false, message: `unknown action ${action}` });
        const message =
          typeof (args as { message?: unknown } | null)?.message === 'string'
            ? (args as { message: string }).message
            : '';
        log('log destination step', { message });
        return Promise.resolve({ ok: true, message: 'logged' });
      },
      health() {
        return Promise.resolve({ status: 'healthy', checkedAt: ctx.now().toISOString() });
      },
    };
  }),
};
