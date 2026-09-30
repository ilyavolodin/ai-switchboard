import {
  asNumber,
  checkHealth,
  dispatchAction,
  getPath,
  InvokeError,
  meterReading,
  parseDefinitive,
  withSettings,
  type ActionSpec,
  type Destination,
  type DestinationType,
  type InvokeResult,
  type MeterReading,
  type MeterSpec,
  type PluginContext,
  type RunHandle,
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

const actions: ActionSpec[] = [
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
];

const STATE_KEY = 'invocations';
const HOUR_MS = 3_600_000;

/** JSON.stringify returns undefined for undefined, despite its declared type. */
function toJson(value: unknown): string {
  return value === undefined ? 'null' : JSON.stringify(value);
}

function preview(value: unknown, max: number): string {
  const text = toJson(value);
  return text.length > max ? `${text.slice(0, max)}… (${text.length} bytes)` : text;
}

export function invokeTimeoutFor(target: unknown): number {
  const delayMs = asNumber(getPath(target, 'delayMs'));
  const delay = delayMs !== undefined ? delayMs / 1000 : 0;
  return Math.max(30, Math.ceil(delay) + 10);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function outcome(target: LogTarget, run: RunHandle, input: unknown): InvokeResult {
  const usage = { invocations: 1, input_bytes: Buffer.byteLength(toJson(input)) };
  switch (target.outcome) {
    case 'ok':
      return {
        status: 'completed',
        externalId: run.id,
        result: { logged: true, runId: run.id, label: target.label ?? null, input },
        usage,
      };
    case 'error':
      return { status: 'failed', errors: ['simulated error from the log destination'], usage };
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
}

function createLogDestination(settings: LogSettings, ctx: PluginContext): Destination {
  const log = (message: string, fields: Record<string, unknown>): void =>
    ctx.logger[settings.level](message, fields);

  async function recentInvocations(now: Date): Promise<number[]> {
    const cutoff = now.getTime() - HOUR_MS;
    return ((await ctx.state.get<number[]>(STATE_KEY)) ?? []).filter((t) => t > cutoff);
  }

  const handlers = {
    log: (args: { message: string }) => {
      log('log destination step', { message: args.message });
      return Promise.resolve({ ok: true, message: 'logged' });
    },
  };

  return {
    async invoke(rawTarget, input, run) {
      const target = parseDefinitive<LogTarget>(targetSchema, rawTarget ?? {}, 'log target');
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
      if (!run.dryRun) {
        await ctx.state.set(STATE_KEY, [...(await recentInvocations(now)), now.getTime()]);
      }
      return outcome(target, run, input);
    },

    async readMeters(): Promise<MeterReading[]> {
      if (settings.hourlyLimit === undefined) return [];
      const now = ctx.now();
      const recent = await recentInvocations(now);
      return [
        meterReading({
          id: meter.id,
          used: recent.length,
          limit: settings.hourlyLimit,
          resetsAt: new Date((recent[0] ?? now.getTime()) + HOUR_MS).toISOString(),
          observedAt: now.toISOString(),
        }),
      ];
    },

    act: (action, args) => dispatchAction(actions, handlers, action, args),

    health: () => checkHealth(ctx, () => Promise.resolve({ status: 'healthy' })),
  };
}

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
  invokeTimeoutFor,
  usage: [
    { id: 'invocations', title: 'Invocations', unit: 'count', aggregate: 'sum', budgetable: true },
    { id: 'input_bytes', title: 'Input size', unit: 'bytes', aggregate: 'sum', budgetable: true },
  ],
  meters: [],
  metersFor: (settings) => (typeof settings.hourlyLimit === 'number' ? [meter] : []),
  actions,
  create: withSettings(settingsSchema, 'log destination settings', createLogDestination),
};
