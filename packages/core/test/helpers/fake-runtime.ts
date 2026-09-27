import {
  InvokeError,
  TransportError,
  dedupeKey,
  isInvokeError,
  isTransportError,
  signHmac,
  verifyHmac,
  type ActionResult,
  type ArtifactRef,
  type ArtifactSnapshot,
  type EventDraft,
  type EventTypeSpec,
  type Executor,
  type ExecutorType,
  type Health,
  type InvokeResult,
  type MeterReading,
  type MeterSpec,
  type NotificationMessage,
  type Notifier,
  type NotifierType,
  type RawRequest,
  type RunHandle,
  type RunStatus,
  type Source,
  type SourceType,
  type TrackingMode,
  type UsageDimension,
} from '@ai-switchboard/sdk';
import { rawRequest } from '@ai-switchboard/sdk/testing';

import type {
  LiveExecutor,
  LiveNotifier,
  LiveSource,
  PluginRuntime,
} from '../../src/plugins/runtime.js';

/**
 * An in-memory PluginRuntime for integration tests: a webhook-like source with HMAC verify, an
 * http-like executor whose behaviour per invoke is scripted, and a recording notifier.
 */

export const HOOK_TYPE = 'fake-hook';
export const EXEC_TYPE = 'fake-exec';
export const NOTIFIER_TYPE = 'fake-notifier';
export const HOOK_PLUGIN = '@test/fake-hook';
export const EXEC_PLUGIN = '@test/fake-exec';

const healthy = (): Health => ({ status: 'healthy', checkedAt: new Date(0).toISOString() });

export const PR_LABELED = 'fake-hook.pr.labeled';
export const ISSUE_UPDATED = 'fake-hook.issue.updated';

export const hookEventTypes: EventTypeSpec[] = [
  {
    type: PR_LABELED,
    title: 'Pull request labeled',
    description: 'A label was added to a pull request.',
    attributes: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'repository'],
      properties: { label: { type: 'string' }, repository: { type: 'string' } },
    },
    examples: [{ label: 'auto:fix', repository: 'acme/api' }],
  },
  {
    type: ISSUE_UPDATED,
    title: 'Issue updated',
    description: 'An issue changed.',
    attributes: {
      type: 'object',
      additionalProperties: false,
      properties: { state: { type: 'string' } },
    },
    examples: [{ state: 'open' }],
  },
];

export interface HookEventBody {
  type: string;
  id: string;
  version?: string;
  kind?: string;
  attributes: Record<string, unknown>;
  occurredAt: string;
}

export interface HookBody {
  deliveryId?: string;
  events: HookEventBody[];
}

/** Build a signed delivery for the fake hook source. */
export function signedDelivery(secret: string, body: HookBody, receivedAt: Date): RawRequest {
  const text = JSON.stringify(body);
  return rawRequest({
    body: text,
    headers: {
      'content-type': 'application/json',
      'x-signature': `sha256=${signHmac({ secret, payload: text })}`,
    },
    receivedAt: receivedAt.toISOString(),
  });
}

export interface FakeSourceState {
  resolved: Map<string, ArtifactSnapshot | null>;
  resolveCalls: ArtifactRef[];
  actions: { action: string; args: unknown }[];
  actionResult: ActionResult;
}

function hookType(): SourceType {
  return {
    id: HOOK_TYPE,
    displayName: 'Fake hook',
    mode: 'push',
    settingsSchema: { type: 'object' },
    eventTypes: hookEventTypes,
    allowsUnauthenticated: true,
    create: () => {
      throw new Error('create through FakeRuntime.addSource');
    },
  };
}

export type Behaviour =
  | 'completed'
  | 'started'
  | 'failed'
  | 'paused'
  | 'refused'
  | 'timeout'
  | '503'
  | '401'
  | '400'
  | { retryAfter: number }
  | { result: InvokeResult }
  | ((run: RunHandle, input: unknown) => Promise<InvokeResult>);

export interface FakeExecutorState {
  tracking: TrackingMode;
  idempotent: boolean;
  script: Behaviour[];
  /** Used when the script is empty. */
  fallback: Behaviour;
  invocations: { target: unknown; input: unknown; run: RunHandle }[];
  pollScript: RunStatus[];
  polls: RunHandle[];
  callbackToken: string;
  readings: MeterReading[];
  usageOnComplete: Record<string, number> | undefined;
  actions: { action: string; args: unknown }[];
}

export const usageDimensions: UsageDimension[] = [
  { id: 'tokens', title: 'Tokens', unit: 'tokens', aggregate: 'sum', budgetable: true },
  {
    id: 'duration_seconds',
    title: 'Duration',
    unit: 'seconds',
    aggregate: 'sum',
    budgetable: false,
  },
];

export const meterSpecs: MeterSpec[] = [
  { id: 'five_hour', title: '5-hour window', kind: 'window', unit: '%', primary: true },
  {
    id: 'daily_runs',
    title: 'Daily runs',
    kind: 'allowance',
    unit: 'runs',
    estimate: { period: 'day', defaultLimit: 50 },
  },
];

export const inputSchema = {
  type: 'object',
  required: ['runId', 'mode'],
  properties: {
    runId: { type: 'string' },
    mode: { enum: ['event', 'sweep'] },
    artifacts: { type: 'array' },
    token: { type: 'string' },
  },
};

function execType(): ExecutorType {
  return {
    id: EXEC_TYPE,
    displayName: 'Fake executor',
    settingsSchema: { type: 'object' },
    targetSchema: { type: 'object' },
    inputSchema,
    tracking: 'sync',
    idempotentInvoke: false,
    usage: usageDimensions,
    meters: meterSpecs,
    create: () => {
      throw new Error('create through FakeRuntime.addExecutor');
    },
  };
}

async function behave(
  b: Behaviour,
  state: FakeExecutorState,
  run: RunHandle,
  input: unknown,
): Promise<InvokeResult> {
  if (typeof b === 'function') return b(run, input);
  if (typeof b === 'object') {
    if ('retryAfter' in b)
      return { status: 'failed', retryAfterSeconds: b.retryAfter, errors: ['429'] };
    return b.result;
  }
  switch (b) {
    case 'completed':
      return {
        status: 'completed',
        externalId: `ext-${run.id.slice(0, 8)}`,
        result: { ok: true },
        ...(state.usageOnComplete ? { usage: state.usageOnComplete } : {}),
      };
    case 'started':
      return {
        status: 'started',
        externalId: `ext-${run.id.slice(0, 8)}`,
        externalUrl: `https://backend.test/runs/${run.id}`,
      };
    case 'failed':
      return { status: 'failed', errors: ['backend said no'] };
    case 'paused':
      return { status: 'held', reason: 'paused' };
    case 'refused':
      throw new TransportError('connect ECONNREFUSED', { sent: false, code: 'ECONNREFUSED' });
    case 'timeout':
      throw new TransportError('request timed out', { sent: true, code: 'ETIMEDOUT' });
    case '503':
      throw new InvokeError('service unavailable', { status: 503 });
    case '401':
      throw new InvokeError('unauthorized', { status: 401, definitive: true });
    case '400':
      throw new InvokeError('bad request', { status: 400, definitive: true });
  }
}

/**
 * Mirrors `PluginHost`'s attribution proxy: a plugin method that throws (anything but a
 * TransportError or InvokeError) is counted against its plugin, then the error propagates. The
 * pipeline relies on this layer, so the fake has it too.
 */
function attributed<T extends object>(
  target: T,
  pluginName: string,
  runtime: { recordPluginError: PluginRuntime['recordPluginError'] },
): T {
  const record = (err: unknown, method: string): void => {
    if (isTransportError(err) || isInvokeError(err)) return;
    runtime.recordPluginError(
      pluginName,
      'exception',
      `${method}: ${err instanceof Error ? err.message : String(err)}`,
    );
  };
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        try {
          const out = fn.apply(obj, args);
          if (out instanceof Promise) {
            return out.catch((err: unknown) => {
              record(err, String(prop));
              throw err;
            });
          }
          return out;
        } catch (err) {
          record(err, String(prop));
          throw err;
        }
      };
    },
  });
}

export interface FakeNotifierState {
  messages: NotificationMessage[];
}

export class FakeRuntime implements PluginRuntime {
  readonly sources = new Map<string, LiveSource>();
  readonly executors = new Map<string, LiveExecutor>();
  readonly notifiers = new Map<string, LiveNotifier>();
  readonly sourceStates = new Map<string, FakeSourceState>();
  readonly executorStates = new Map<string, FakeExecutorState>();
  readonly notifierStates = new Map<string, FakeNotifierState>();
  readonly errors: { plugin: string; kind: string; detail?: string }[] = [];
  readonly instanceErrors = new Map<string, string>();
  /** Types whose plugin is "uninstalled". */
  readonly unavailableTypes = new Set<string>();

  sourceType(typeId: string) {
    return typeId === HOOK_TYPE && !this.unavailableTypes.has(typeId)
      ? { type: hookType(), pluginName: HOOK_PLUGIN }
      : undefined;
  }

  executorType(typeId: string) {
    return typeId === EXEC_TYPE && !this.unavailableTypes.has(typeId)
      ? { type: execType(), pluginName: EXEC_PLUGIN }
      : undefined;
  }

  notifierType(typeId: string) {
    if (typeId !== NOTIFIER_TYPE) return undefined;
    const type: NotifierType = {
      id: NOTIFIER_TYPE,
      displayName: 'Fake notifier',
      settingsSchema: { type: 'object' },
      create: () => {
        throw new Error('create through FakeRuntime.addNotifier');
      },
    };
    return { type, pluginName: '@test/fake-notifier' };
  }

  secretProviderType() {
    return undefined;
  }

  source(id: string): LiveSource | undefined {
    const live = this.sources.get(id);
    return live && !this.unavailableTypes.has(live.typeId) && !this.instanceErrors.has(id)
      ? live
      : undefined;
  }

  executor(id: string): LiveExecutor | undefined {
    const live = this.executors.get(id);
    return live && !this.unavailableTypes.has(live.typeId) && !this.instanceErrors.has(id)
      ? live
      : undefined;
  }

  notifier(id: string): LiveNotifier | undefined {
    return this.notifiers.get(id);
  }

  instanceError(id: string): string | undefined {
    const live = this.sources.get(id) ?? this.executors.get(id);
    if (live && this.unavailableTypes.has(live.typeId)) return 'plugin_unavailable';
    return this.instanceErrors.get(id);
  }

  reload(): Promise<void> {
    return Promise.resolve();
  }

  recordPluginError(
    pluginName: string,
    kind: 'exception' | 'invalid_event' | 'invalid_usage',
    detail?: string,
  ): void {
    this.errors.push({ plugin: pluginName, kind, ...(detail !== undefined ? { detail } : {}) });
  }

  addSource(id: string, name: string, secret: string): FakeSourceState {
    const state: FakeSourceState = {
      resolved: new Map(),
      resolveCalls: [],
      actions: [],
      actionResult: { ok: true },
    };
    const type = hookType();
    this.sources.set(id, {
      id,
      name,
      typeId: HOOK_TYPE,
      pluginName: HOOK_PLUGIN,
      type,
      eventTypes: type.eventTypes,
      secretValues: [secret],
      source: attributed<Source>(
        {
          verify: (req) =>
            verifyHmac({
              secret,
              payload: req.body,
              signature: req.headers['x-signature'],
              prefix: 'sha256=',
            })
              ? { ok: true }
              : { ok: false, reason: 'bad signature' },
          parse: (req): EventDraft[] => {
            const body = JSON.parse(req.body.toString('utf8')) as HookBody;
            return body.events.map((e) => {
              const artifact: ArtifactRef = {
                kind: e.kind ?? 'fake.pr',
                id: e.id,
                ...(e.version !== undefined ? { version: e.version } : {}),
              };
              return {
                type: e.type,
                occurredAt: e.occurredAt,
                artifact,
                attributes: e.attributes as EventDraft['attributes'],
                dedupeKey: dedupeKey(e.type, artifact, body.deliveryId),
                ...(body.deliveryId !== undefined ? { deliveryId: body.deliveryId } : {}),
              };
            });
          },
          resolve: (ref) => {
            state.resolveCalls.push(ref);
            return Promise.resolve(state.resolved.get(`${ref.kind}:${ref.id}`) ?? null);
          },
          act: (action, args) => {
            state.actions.push({ action, args });
            return Promise.resolve(state.actionResult);
          },
          health: () => Promise.resolve(healthy()),
        },
        HOOK_PLUGIN,
        this,
      ),
    });
    this.sourceStates.set(id, state);
    return state;
  }

  addExecutor(
    id: string,
    name: string,
    options: Partial<
      Pick<FakeExecutorState, 'tracking' | 'idempotent' | 'fallback' | 'callbackToken'>
    > = {},
  ): FakeExecutorState {
    const state: FakeExecutorState = {
      tracking: options.tracking ?? 'sync',
      idempotent: options.idempotent ?? false,
      script: [],
      fallback:
        options.fallback ??
        (options.tracking === 'callback' || options.tracking === 'poll' ? 'started' : 'completed'),
      invocations: [],
      pollScript: [],
      polls: [],
      callbackToken: options.callbackToken ?? 'callback-token',
      readings: [],
      usageOnComplete: undefined,
      actions: [],
    };
    const type = execType();
    this.executors.set(id, {
      id,
      name,
      typeId: EXEC_TYPE,
      pluginName: EXEC_PLUGIN,
      type,
      usage: usageDimensions,
      meters: meterSpecs,
      trackingFor: () => state.tracking,
      idempotentFor: () => state.idempotent,
      executor: attributed<Executor>(
        {
          invoke: async (target, input, run) => {
            state.invocations.push({ target, input, run });
            const next = state.script.shift() ?? state.fallback;
            return behave(next, state, run, input);
          },
          poll: (run) => {
            state.polls.push(run);
            return Promise.resolve(state.pollScript.shift() ?? { state: 'running' });
          },
          verifyCallback: (req) => {
            if (req.headers['x-callback-token'] !== state.callbackToken) return null;
            const body = JSON.parse(req.body.toString('utf8')) as { runId: string } & RunStatus;
            const { runId, ...status } = body;
            return { runId, status };
          },
          readMeters: () => Promise.resolve(state.readings),
          act: (action, args) => {
            state.actions.push({ action, args });
            return Promise.resolve({ ok: true });
          },
          health: () => Promise.resolve(healthy()),
        },
        EXEC_PLUGIN,
        this,
      ),
    });
    this.executorStates.set(id, state);
    return state;
  }

  addNotifier(id: string, name: string): FakeNotifierState {
    const state: FakeNotifierState = { messages: [] };
    const type = this.notifierType(NOTIFIER_TYPE)?.type;
    if (!type) throw new Error('no notifier type');
    this.notifiers.set(id, {
      id,
      name,
      typeId: NOTIFIER_TYPE,
      type,
      notifier: attributed<Notifier>(
        {
          send: (message) => {
            state.messages.push(message);
            return Promise.resolve();
          },
          health: () => Promise.resolve(healthy()),
        },
        '@test/fake-notifier',
        this,
      ),
    });
    this.notifierStates.set(id, state);
    return state;
  }
}

/** A callback request for the fake executor. */
export function callbackRequest(token: string, body: Record<string, unknown>): RawRequest {
  return rawRequest({
    path: '/callbacks/x',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-callback-token': token },
  });
}
