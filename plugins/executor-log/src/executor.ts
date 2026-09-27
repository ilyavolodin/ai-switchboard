import {
  InvokeError,
  validateAgainst,
  type ExecutorType,
  type JSONSchema,
  type MeterSpec,
  type PluginContext,
  type Settings,
} from '@ai-switchboard/sdk';

export type Outcome = 'ok' | 'error' | 'failed' | 'held' | 'rate_limited';

export interface LogSettings {
  level: 'debug' | 'info' | 'warn';
  logInput: boolean;
  maxLoggedBytes: number;
  /** When set, the `hourly_runs` meter reports invocations in the last hour against this limit. */
  hourlyLimit?: number;
}

export interface LogTarget {
  label?: string;
  outcome: Outcome;
  delayMs: number;
  retryAfterSeconds: number;
}

export const settingsSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    level: {
      enum: ['debug', 'info', 'warn'],
      default: 'info',
      title: 'Log level',
      description: 'The level of the log line written for every invocation.',
      'x-group': 'Logging',
    },
    logInput: {
      type: 'boolean',
      default: true,
      title: 'Log the input',
      description: 'Include the mapped input in the log line (truncated to the size below).',
      'x-group': 'Logging',
    },
    maxLoggedBytes: {
      type: 'integer',
      minimum: 64,
      maximum: 65_536,
      default: 4096,
      title: 'Largest logged input (bytes)',
      description:
        'Inputs longer than this are truncated in the log line; the run keeps them whole.',
      'x-group': 'Logging',
    },
    hourlyLimit: {
      type: 'integer',
      minimum: 1,
      title: 'Simulated hourly limit',
      description:
        'Optional. Adds an "Hourly runs" meter that reports invocations in the last hour against this limit, so ceilings and throttling can be tried out.',
      'x-group': 'Simulated meter',
    },
  },
};

export const targetSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: {
      type: 'string',
      maxLength: 120,
      title: 'Label',
      description: 'A word to find this process in the log.',
    },
    outcome: {
      enum: ['ok', 'error', 'failed', 'held', 'rate_limited'],
      default: 'ok',
      title: 'Simulated outcome',
      description:
        'ok: the run succeeds. error: the backend reports an error (counts toward the breaker). failed: a definitive refusal. held: the target is paused. rate_limited: out of capacity (opens a soft-hold).',
    },
    delayMs: {
      type: 'integer',
      minimum: 0,
      maximum: 30_000,
      default: 0,
      title: 'Delay (ms)',
      description: 'Wait this long before answering, to see a run in flight.',
    },
    retryAfterSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 86_400,
      default: 60,
      title: 'Retry after (s)',
      description: 'For the rate_limited outcome: how long the soft-hold lasts.',
    },
  },
};

const meter: MeterSpec = {
  id: 'hourly_runs',
  title: 'Hourly runs',
  kind: 'window',
  unit: '%',
  primary: true,
};

const STATE_KEY = 'invocations';
const HOUR_MS = 3_600_000;

export function parseSettings(settings: Settings): LogSettings {
  const copy = structuredClone(settings);
  const check = validateAgainst(settingsSchema, copy);
  if (!check.valid) throw new Error(`Invalid log executor settings: ${check.errors.join('; ')}`);
  return copy as unknown as LogSettings;
}

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const logExecutorType: ExecutorType = {
  id: 'log',
  displayName: 'Log (test executor)',
  description:
    'Writes every invocation to the server log and answers with the input. Simulates outcomes, delays and a meter, so a process can be tried out without a real backend.',
  settingsSchema,
  targetSchema,
  inputSchema: {},
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
    },
  ],
  create(rawSettings, ctx) {
    const settings = parseSettings(rawSettings);
    const log = (message: string, fields: Record<string, unknown>): void =>
      ctx.logger[settings.level](message, fields);
    return {
      async invoke(rawTarget, input, run) {
        const target = parseTarget(rawTarget);
        const now = ctx.now();
        log('log executor invocation', {
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
            return { status: 'failed', errors: ['simulated error from the log executor'], usage };
          case 'failed':
            throw new InvokeError('simulated definitive refusal from the log executor', {
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
        log('log executor step', { message });
        return Promise.resolve({ ok: true, message: 'logged' });
      },
      health() {
        return Promise.resolve({ status: 'healthy', checkedAt: ctx.now().toISOString() });
      },
    };
  },
};
