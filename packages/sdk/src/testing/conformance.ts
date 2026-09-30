import { HEALTH_STATUSES, INVOKE_STATUSES, RUN_STATES } from '../constants.js';
import { isCapabilityError, isSecretNotFoundError, isWritableSecretProvider } from '../errors.js';
import type { HttpClient } from '../http.js';
import { isOneOf } from '../json.js';
import { definePlugin, validatePlugin, type PluginDefinition } from '../plugin.js';
import { isValidSchema, schemaFields, validateAgainst, xSecret } from '../schema/index.js';
import type { JSONSchema, RawRequest, Settings } from '../types/common.js';
import type { ArtifactRef, EventDraft, EventTypeSpec } from '../types/events.js';
import type {
  Destination,
  DestinationType,
  Input,
  InvokeResult,
  RunHandle,
  Target,
  TrackingMode,
  UsageReport,
} from '../types/destination.js';
import type {
  NotificationMessage,
  Notifier,
  NotifierType,
  SecretProvider,
  SecretProviderType,
} from '../types/notifier.js';
import type { Source, SourceType } from '../types/source.js';
import { createStubHttp, createTestContext, runHandle, type StubHandler } from './stubs.js';

/** One named conformance check; `run` throws with a message on failure. */
export interface ConformanceCheck {
  name: string;
  run(): Promise<void>;
}

export class ConformanceFailure extends Error {
  override readonly name = 'ConformanceFailure';
}

/** Where calls outside the declared network capability are recorded. */
type Violations = string[];

function guarded(client: HttpClient, violations: Violations): HttpClient {
  const record = <T>(work: Promise<T>): Promise<T> =>
    work.catch((err: unknown) => {
      if (isCapabilityError(err)) violations.push(err.message);
      throw err;
    });
  return {
    request: (req) => record(client.request(req)),
    get: (url, options) => record(client.get(url, options)),
    post: (url, options) => record(client.post(url, options)),
  };
}

function testHttp(
  handler: StubHandler | undefined,
  allowedHosts: string[] | undefined,
  violations: Violations,
): HttpClient {
  return guarded(createStubHttp(handler, allowedHosts).client, violations);
}

function fail(message: string): never {
  throw new ConformanceFailure(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

export interface SourceFixtures {
  /** Resolved settings (secret values inline) for `create`. */
  settings: Settings;
  /** Values that must never appear in any attribute (the instance's secrets). */
  secrets?: string[];
  /** Stubs the source's outbound API (resolve, linked, poll, provision). */
  http?: StubHandler;
  /** The declared network capability; `pluginConformanceChecks` fills it from the plugin. */
  allowedHosts?: string[];
  now?: () => Date;
  push?: {
    /** Correctly signed deliveries; each must verify and parse to ≥ 0 conforming events. */
    deliveries: RawRequest[];
    /** Two deliveries of the same change (e.g. a redelivery): equal dedupe keys. */
    sameChange: [RawRequest, RawRequest];
    /** Two different changes to the same artifact: different dedupe keys. */
    differentChange: [RawRequest, RawRequest];
    wrongSignature: RawRequest;
    missingHeader: RawRequest;
    /** Only for sources that check a timestamp. */
    staleTimestamp?: RawRequest;
  };
  /** An artifact the `http` stub answers with 404; `resolve` must return null without throwing. */
  resolveNotFound?: ArtifactRef;
  /** For pull sources. Polling twice with the returned watermark must not re-emit. */
  poll?: { initialWatermark: string | null; expectEvents?: boolean };
}

function eventTypesFor(type: SourceType, settings: Settings): EventTypeSpec[] {
  return type.dynamicEventTypes && type.instanceEventTypes
    ? type.instanceEventTypes(settings)
    : type.eventTypes;
}

function checkEvents(
  events: EventDraft[],
  specs: EventTypeSpec[],
  raw: Buffer | null,
  secrets: string[],
): void {
  const byType = new Map(specs.map((s) => [s.type, s]));
  for (const ev of events) {
    const spec = byType.get(ev.type);
    assert(spec, `event type "${ev.type}" is not declared`);
    const check = validateAgainst(spec.attributes, ev.attributes);
    assert(
      check.valid,
      `event ${ev.type} attributes do not match the declared schema: ${check.errors.join('; ')}`,
    );
    assert(
      typeof ev.dedupeKey === 'string' && ev.dedupeKey !== '',
      `event ${ev.type} has no dedupeKey`,
    );
    assert(
      ev.artifact.kind !== '' && ev.artifact.id !== '',
      `event ${ev.type} has an empty artifact ref`,
    );
    assert(!Number.isNaN(Date.parse(ev.occurredAt)), `event ${ev.type} occurredAt is not ISO-8601`);
    const rawText = raw && raw.length > 32 ? raw.toString('utf8') : null;
    for (const [key, value] of Object.entries(ev.attributes)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (typeof v !== 'string') continue;
        assert(rawText === null || v !== rawText, `attribute "${key}" contains the raw body`);
        for (const secret of secrets) {
          assert(
            secret === '' || !v.includes(secret),
            `attribute "${key}" contains a secret value`,
          );
        }
      }
    }
  }
}

export function sourceConformanceChecks(
  type: SourceType,
  fixtures: SourceFixtures,
): ConformanceCheck[] {
  return sourceChecks(type, fixtures, []);
}

function sourceChecks(
  type: SourceType,
  fixtures: SourceFixtures,
  violations: Violations,
): ConformanceCheck[] {
  const http = testHttp(fixtures.http, fixtures.allowedHosts, violations);
  const make = (): Source =>
    type.create(
      fixtures.settings,
      createTestContext({ http, ...(fixtures.now ? { now: fixtures.now } : {}) }),
    );
  const secrets = fixtures.secrets ?? [];
  const specs = (): EventTypeSpec[] => eventTypesFor(type, fixtures.settings);
  const checks: ConformanceCheck[] = [
    {
      name: 'manifest validates',
      run: () => {
        const errors = validatePlugin(
          definePlugin({ id: 'conformance', displayName: 'Conformance', sources: [type] }),
        );
        assert(errors.length === 0, errors.join('\n'));
        return Promise.resolve();
      },
    },
    {
      name: 'every declared event type has a schema and at least one example',
      run: () => {
        for (const et of specs()) {
          assert(isValidSchema(et.attributes).valid, `${et.type}: invalid attributes schema`);
          assert(et.examples.length > 0, `${et.type}: no examples`);
        }
        return Promise.resolve();
      },
    },
    {
      name: 'health() resolves to a Health',
      run: async () => {
        const h = await make().health();
        assert(isOneOf(HEALTH_STATUSES, h.status), 'health status is invalid');
      },
    },
  ];

  if (type.mode !== 'pull') {
    const push = fixtures.push;
    checks.push({
      name: 'push fixtures are provided',
      run: () => {
        assert(push, 'push or both-mode sources must provide push fixtures');
        return Promise.resolve();
      },
    });
    if (push) {
      checks.push(
        {
          name: 'verify accepts correctly signed deliveries',
          run: () => {
            const src = make();
            if (!src.verify) {
              assert(
                type.allowsUnauthenticated,
                'verify is required unless the type allows unauthenticated instances',
              );
              return Promise.resolve();
            }
            for (const d of push.deliveries) {
              const r = src.verify(d);
              assert(r.ok, `verify rejected a valid delivery: ${r.ok ? '' : r.reason}`);
            }
            return Promise.resolve();
          },
        },
        {
          name: 'verify rejects a wrong signature, a missing header and a stale timestamp',
          run: () => {
            const src = make();
            if (!src.verify) return Promise.resolve();
            assert(!src.verify(push.wrongSignature).ok, 'verify accepted a wrong signature');
            assert(
              !src.verify(push.missingHeader).ok,
              'verify accepted a request missing its signature header',
            );
            if (push.staleTimestamp)
              assert(!src.verify(push.staleTimestamp).ok, 'verify accepted a stale timestamp');
            return Promise.resolve();
          },
        },
        {
          name: 'parse is deterministic and its events validate against the declared schemas',
          run: async () => {
            const src = make();
            assert(typeof src.parse === 'function', 'push sources must implement parse');
            for (const d of push.deliveries) {
              const a = await src.parse(d);
              const b = await make().parse?.(d);
              assert(
                JSON.stringify(a) === JSON.stringify(b),
                'parse returned different events for the same delivery',
              );
              checkEvents(a, specs(), d.body, secrets);
            }
          },
        },
        {
          name: 'parseWithNotes (when present) returns the same events as parse',
          run: async () => {
            const src = make();
            if (typeof src.parseWithNotes !== 'function') return;
            for (const d of push.deliveries) {
              const events = (await src.parse?.(d)) ?? [];
              const report = await src.parseWithNotes(d);
              assert(
                Array.isArray(report.events) && Array.isArray(report.notes),
                'parseWithNotes must return { events, notes }',
              );
              assert(
                JSON.stringify(report.events) === JSON.stringify(events),
                'parseWithNotes returned different events than parse',
              );
              assert(
                report.notes.every((n) => typeof n === 'string'),
                'parseWithNotes notes must be strings',
              );
              const raw = d.body.length > 32 ? d.body.toString('utf8') : null;
              for (const note of report.notes) {
                assert(raw === null || !note.includes(raw), 'a note contains the raw body');
                for (const secret of secrets) {
                  assert(secret === '' || !note.includes(secret), 'a note contains a secret value');
                }
              }
            }
          },
        },
        {
          name: 'dedupeKey is stable for the same change and differs across changes',
          run: async () => {
            const src = make();
            const keys = async (r: RawRequest): Promise<string[]> =>
              ((await src.parse?.(r)) ?? []).map((e) => e.dedupeKey).sort();
            const [s1, s2] = push.sameChange;
            const k1 = await keys(s1);
            assert(k1.length > 0, 'sameChange fixture produced no events');
            assert(
              JSON.stringify(k1) === JSON.stringify(await keys(s2)),
              'same change produced different dedupe keys',
            );
            const [d1, d2] = push.differentChange;
            const a = await keys(d1);
            const b = await keys(d2);
            assert(a.length > 0 && b.length > 0, 'differentChange fixtures produced no events');
            assert(!a.some((k) => b.includes(k)), 'different changes share a dedupe key');
          },
        },
      );
    }
  }

  if (fixtures.resolveNotFound) {
    const ref = fixtures.resolveNotFound;
    checks.push({
      name: 'resolve handles a 404',
      run: async () => {
        const src = make();
        assert(
          typeof src.resolve === 'function',
          'resolveNotFound fixture given but resolve is not implemented',
        );
        const snap = await src.resolve(ref);
        assert(snap === null, 'resolve of a missing artifact must return null');
      },
    });
  }

  if (type.mode !== 'push') {
    checks.push({
      name: 'poll advances the watermark and never re-emits',
      run: async () => {
        const src = make();
        assert(typeof src.poll === 'function', 'pull sources must implement poll');
        assert(fixtures.poll, 'pull sources must provide poll fixtures');
        const first = await src.poll(fixtures.poll.initialWatermark);
        assert(
          typeof first.watermark === 'string' && first.watermark !== '',
          'poll returned no watermark',
        );
        checkEvents(first.events, specs(), null, secrets);
        if (fixtures.poll.expectEvents !== false)
          assert(first.events.length > 0, 'first poll produced no events');
        const second = await src.poll(first.watermark);
        const seen = new Set(first.events.map((e) => e.dedupeKey));
        assert(
          !second.events.some((e) => seen.has(e.dedupeKey)),
          'poll re-emitted an event after the watermark',
        );
      },
    });
  }
  return checks;
}

export interface DestinationFixtures {
  settings: Settings;
  http: StubHandler;
  /** Defaults to `type.examples[0]`. */
  target?: Target;
  input?: Input;
  run?: Partial<RunHandle>;
  /** Required for callback tracking: a callback without a valid signature. */
  unsignedCallback?: RawRequest;
  /** The declared network capability; `pluginConformanceChecks` fills it from the plugin. */
  allowedHosts?: string[];
  now?: () => Date;
}

function checkUsage(
  type: DestinationType,
  settings: Settings,
  usage: UsageReport | undefined,
  where: string,
): void {
  if (!usage) return;
  const declared = new Set((type.usageFor ? type.usageFor(settings) : type.usage).map((d) => d.id));
  for (const [key, value] of Object.entries(usage)) {
    assert(declared.has(key), `${where}: usage key "${key}" is not a declared dimension`);
    assert(
      typeof value === 'number' && Number.isFinite(value),
      `${where}: usage "${key}" is not a finite number`,
    );
  }
}

function checkInvokeResult(r: InvokeResult, tracking: TrackingMode): void {
  assert(isOneOf(INVOKE_STATUSES, r.status), `invalid InvokeResult.status "${r.status}"`);
  if (tracking !== 'sync') {
    assert(r.status !== 'completed', 'only sync destinations may return status "completed"');
  }
  if (r.retryAfterSeconds !== undefined) {
    assert(r.retryAfterSeconds >= 0, 'retryAfterSeconds must be ≥ 0');
  }
}

export function destinationConformanceChecks(
  type: DestinationType,
  fixtures: DestinationFixtures,
): ConformanceCheck[] {
  return destinationChecks(type, fixtures, []);
}

function destinationChecks(
  type: DestinationType,
  fixtures: DestinationFixtures,
  violations: Violations,
): ConformanceCheck[] {
  const example = type.examples?.[0];
  const target = fixtures.target ?? example?.target;
  const input = fixtures.input ?? example?.input;
  const make = (): Destination =>
    type.create(
      fixtures.settings,
      createTestContext({
        http: testHttp(fixtures.http, fixtures.allowedHosts, violations),
        ...(fixtures.now ? { now: fixtures.now } : {}),
      }),
    );
  const tracking = (): TrackingMode =>
    type.trackingFor ? type.trackingFor(target) : type.tracking;

  return [
    {
      name: 'manifest validates',
      run: () => {
        const errors = validatePlugin(
          definePlugin({ id: 'conformance', displayName: 'Conformance', destinations: [type] }),
        );
        assert(errors.length === 0, errors.join('\n'));
        return Promise.resolve();
      },
    },
    {
      name: 'targetSchema and inputSchema are valid schemas with examples',
      run: () => {
        assert(isValidSchema(type.targetSchema).valid, 'targetSchema is invalid');
        assert(isValidSchema(type.inputSchema).valid, 'inputSchema is invalid');
        assert(
          (type.examples ?? []).length > 0,
          'at least one { target, input } example is required',
        );
        return Promise.resolve();
      },
    },
    {
      name: 'idempotentInvoke is declared',
      run: () => {
        assert(typeof type.idempotentInvoke === 'boolean', 'idempotentInvoke must be a boolean');
        return Promise.resolve();
      },
    },
    {
      name: 'the declared tracking mode has its method',
      run: () => {
        const ex = make();
        const mode = tracking();
        if (mode === 'poll')
          assert(typeof ex.poll === 'function', 'tracking "poll" requires poll()');
        if (mode === 'callback')
          assert(
            typeof ex.verifyCallback === 'function',
            'tracking "callback" requires verifyCallback()',
          );
        return Promise.resolve();
      },
    },
    {
      name: 'invoke with the example target and input returns a well-formed InvokeResult',
      run: async () => {
        const ex = make();
        const handle = runHandle(fixtures.run);
        const result = await ex.invoke(target, input, handle);
        checkInvokeResult(result, tracking());
        checkUsage(type, fixtures.settings, result.usage, 'invoke');
        if (tracking() === 'poll' && result.status === 'started') {
          assert(typeof ex.poll === 'function', 'poll missing');
          const status = await ex.poll({
            ...handle,
            ...(result.externalId ? { externalId: result.externalId } : {}),
          });
          assert(isOneOf(RUN_STATES, status.state), 'poll returned an invalid state');
          checkUsage(type, fixtures.settings, status.usage, 'poll');
        }
      },
    },
    {
      name: 'verifyCallback rejects an unsigned request',
      run: () => {
        const ex = make();
        if (tracking() !== 'callback' && !ex.verifyCallback) return Promise.resolve();
        assert(
          fixtures.unsignedCallback,
          'callback destinations must provide an unsignedCallback fixture',
        );
        assert(typeof ex.verifyCallback === 'function', 'verifyCallback missing');
        assert(
          ex.verifyCallback(fixtures.unsignedCallback) === null,
          'verifyCallback accepted an unsigned request',
        );
        return Promise.resolve();
      },
    },
    {
      name: 'readMeters returns readings matching the declared meters',
      run: async () => {
        const ex = make();
        const specs = type.metersFor ? type.metersFor(fixtures.settings) : (type.meters ?? []);
        if (!ex.readMeters) return;
        const readings = await ex.readMeters();
        const ids = new Set(specs.map((m) => m.id));
        for (const r of readings) {
          assert(ids.has(r.id), `reading for undeclared meter "${r.id}"`);
          assert(
            r.utilization >= 0 && r.utilization <= 100,
            `meter ${r.id} utilization out of 0–100`,
          );
          assert(
            !Number.isNaN(Date.parse(r.observedAt)),
            `meter ${r.id} observedAt is not ISO-8601`,
          );
        }
      },
    },
    {
      name: 'every usage dimension has a unit',
      run: () => {
        for (const d of type.usageFor ? type.usageFor(fixtures.settings) : type.usage) {
          assert(d.unit !== '', `dimension ${d.id} has no unit`);
        }
        return Promise.resolve();
      },
    },
  ];
}

export interface SecretProviderFixtures {
  /** Plain values: secret providers take no secret references themselves. */
  settings: Settings;
  /** Names the provider must list with these settings (the test seeds them first). */
  expectNames?: string[];
  /** Extra values that must never appear in the listing, besides every value `resolve` returns. */
  secrets?: string[];
  now?: () => Date;
  /** Where the write checks store their probe value (a writable provider only). */
  writableName?: string;
}

function probeValue(): string {
  return `conformance-probe-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function errorTexts(err: unknown): string {
  if (err instanceof Error) return `${err.message}\n${err.stack ?? ''}`;
  return String(err);
}

async function expectMissing(provider: SecretProvider, name: string, when: string): Promise<void> {
  try {
    await provider.resolve(name);
  } catch (err) {
    assert(isSecretNotFoundError(err), `resolve() ${when} must throw SecretNotFoundError`);
    return;
  }
  throw new ConformanceFailure(`resolve() ${when} still returns a value`);
}

function writableProviderChecks(
  type: SecretProviderType,
  fixtures: SecretProviderFixtures,
): ConformanceCheck[] {
  const context = () => createTestContext(fixtures.now ? { now: fixtures.now } : {});
  const name = fixtures.writableName ?? 'switchboard-conformance-probe';
  return [
    {
      name: 'set() and delete() come together',
      run: () => {
        const provider = type.create(fixtures.settings, context());
        const hasSet = typeof provider.set === 'function';
        const hasDelete = typeof provider.delete === 'function';
        assert(hasSet === hasDelete, 'a writable provider implements both set() and delete()');
        return Promise.resolve();
      },
    },
    {
      name: 'set() and delete() round-trip through resolve()',
      run: async () => {
        const provider = type.create(fixtures.settings, context());
        if (!isWritableSecretProvider(provider)) return;
        const first = probeValue();
        const second = probeValue();
        try {
          await provider.set(name, first);
          assert(
            (await provider.resolve(name).catch(() => undefined)) === first,
            'resolve() after set() must return the stored value',
          );
          await provider.set(name, second);
          assert(
            (await provider.resolve(name).catch(() => undefined)) === second,
            'resolve() after a second set() must return the new value',
          );
        } finally {
          await provider.delete(name);
        }
        await expectMissing(provider, name, 'after delete()');
        await provider.delete(name);
      },
    },
    {
      name: 'writes never put the value in an error or a log line',
      run: async () => {
        const ctx = context();
        const provider = type.create(fixtures.settings, ctx);
        if (!isWritableSecretProvider(provider)) return;
        const value = probeValue();
        for (const bad of ['', '../escape', 'a/b', 'x\0y']) {
          try {
            await provider.set(bad, value);
            await provider.delete(bad);
          } catch (err) {
            assert(
              !errorTexts(err).includes(value),
              `set() put the value in an error for "${bad}"`,
            );
          }
        }
        try {
          await provider.set(name, value);
          await provider.delete(name);
        } catch (err) {
          // Whether the write works is the round-trip check's business; here only leaks count.
          assert(!errorTexts(err).includes(value), 'a write put the value in an error');
        }
        assert(!JSON.stringify(ctx.logs).includes(value), 'a write put the value in a log line');
      },
    },
  ];
}

const LISTING_KEYS = new Set(['name', 'description', 'updatedAt']);

/** Keys included. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...stringsIn(v)]);
  }
  return [];
}

/**
 * A `list()` listing must not contain any resolved value: values of 4+ characters are matched
 * as substrings, shorter ones only as an exact field.
 */
export function secretProviderConformanceChecks(
  type: SecretProviderType,
  fixtures: SecretProviderFixtures,
): ConformanceCheck[] {
  const make = (): SecretProvider =>
    type.create(fixtures.settings, createTestContext(fixtures.now ? { now: fixtures.now } : {}));
  return [
    {
      name: 'manifest validates',
      run: () => {
        const errors = validatePlugin(
          definePlugin({ id: 'conformance', displayName: 'Conformance', secretProviders: [type] }),
        );
        assert(errors.length === 0, errors.join('\n'));
        return Promise.resolve();
      },
    },
    {
      name: 'health() resolves to a Health',
      run: async () => {
        const h = await make().health();
        assert(isOneOf(HEALTH_STATUSES, h.status), 'health status is invalid');
      },
    },
    {
      name: 'list() returns well-formed names',
      run: async () => {
        const provider = make();
        if (typeof provider.list !== 'function') return;
        const listing: unknown = await provider.list();
        assert(Array.isArray(listing), 'list() must return an array');
        const seen = new Set<string>();
        for (const entry of listing as unknown[]) {
          assert(
            entry !== null && typeof entry === 'object' && !Array.isArray(entry),
            'list() entries must be objects',
          );
          const e = entry as Record<string, unknown>;
          for (const key of Object.keys(e)) {
            assert(LISTING_KEYS.has(key), `list() entry has an unexpected field "${key}"`);
          }
          assert(typeof e.name === 'string' && e.name !== '', 'list() entry has no name');
          assert(!seen.has(e.name), `list() returned "${e.name}" twice`);
          seen.add(e.name);
          if (e.description !== undefined)
            assert(typeof e.description === 'string', `${e.name}: description must be a string`);
          if (e.updatedAt !== undefined)
            assert(
              typeof e.updatedAt === 'string' && !Number.isNaN(Date.parse(e.updatedAt)),
              `${e.name}: updatedAt is not ISO-8601`,
            );
        }
        for (const name of fixtures.expectNames ?? []) {
          assert(seen.has(name), `list() does not include the expected name "${name}"`);
        }
      },
    },
    {
      name: 'list() never contains a secret value',
      run: async () => {
        const provider = make();
        if (typeof provider.list !== 'function') return;
        const listing = await provider.list();
        const values = [...(fixtures.secrets ?? [])];
        for (const entry of listing) {
          try {
            values.push(await provider.resolve(entry.name));
          } catch {
            // An unresolvable name (e.g. an empty value) leaks nothing.
          }
        }
        const fields = stringsIn(listing);
        const text = JSON.stringify(listing);
        for (const value of values) {
          if (value === '') continue;
          const leaked = value.length >= 4 ? text.includes(value) : fields.includes(value);
          assert(!leaked, 'list() output contains a secret value');
        }
      },
    },
    ...writableProviderChecks(type, fixtures),
  ];
}

export interface NotifierFixtures {
  settings: Settings;
  /** Stubs the backend; the default answers 200 `{"ok":true}`. */
  http?: StubHandler;
  /** Defaults to an `error` notification with a title, text, URL and fields. */
  message?: NotificationMessage;
  /** The declared network capability; `pluginConformanceChecks` fills it from the plugin. */
  allowedHosts?: string[];
  now?: () => Date;
}

const EXAMPLE_NOTIFICATION: NotificationMessage = {
  on: 'error',
  severity: 'error',
  title: 'Run failed: Triage alerts',
  text: 'The destination answered 500.',
  url: 'https://switchboard.test/runs/1',
  fields: { process: 'Triage alerts', status: 'failed' },
};

const OK_REPLY: StubHandler = () => ({ status: 200, json: { ok: true } });

export function notifierConformanceChecks(
  type: NotifierType,
  fixtures: NotifierFixtures,
): ConformanceCheck[] {
  return notifierChecks(type, fixtures, []);
}

function notifierChecks(
  type: NotifierType,
  fixtures: NotifierFixtures,
  violations: Violations,
): ConformanceCheck[] {
  const make = (handler: StubHandler): { notifier: Notifier; calls: () => number } => {
    const stub = createStubHttp(handler, fixtures.allowedHosts);
    const notifier = type.create(
      fixtures.settings,
      createTestContext({
        http: guarded(stub.client, violations),
        ...(fixtures.now ? { now: fixtures.now } : {}),
      }),
    );
    return { notifier, calls: () => stub.calls.length };
  };
  const message = fixtures.message ?? EXAMPLE_NOTIFICATION;
  return [
    {
      name: 'manifest validates',
      run: () => {
        const errors = validatePlugin(
          definePlugin({ id: 'conformance', displayName: 'Conformance', notifiers: [type] }),
        );
        assert(errors.length === 0, errors.join('\n'));
        return Promise.resolve();
      },
    },
    {
      name: 'health() resolves to a Health',
      run: async () => {
        const h = await make(fixtures.http ?? OK_REPLY).notifier.health();
        assert(isOneOf(HEALTH_STATUSES, h.status), 'health status is invalid');
      },
    },
    {
      name: 'send delivers a message with one or more requests',
      run: async () => {
        const { notifier, calls } = make(fixtures.http ?? OK_REPLY);
        await notifier.send(message);
        assert(calls() > 0, 'send made no request');
      },
    },
    {
      name: 'send rejects when the backend refuses',
      run: async () => {
        const { notifier } = make(() => ({ status: 500, body: 'unavailable' }));
        let rejected = false;
        try {
          await notifier.send(message);
        } catch {
          rejected = true;
        }
        assert(rejected, 'send resolved although the backend answered 500');
      },
    },
  ];
}

export interface SettingsSchemaOptions {
  /** Field names that look like credentials but are not (e.g. a header *name*). */
  notSecret?: string[];
}

const CREDENTIAL_NAME =
  /(token|secret|password|passphrase|apikey|appkey|privatekey|accesskey|signingkey)$/i;

/**
 * The settings-form rules: every field has a `title` and a `description` (the UI renders the
 * form from them), and every credential-looking field is marked `x-secret: true`.
 */
export function settingsSchemaChecks(
  schema: JSONSchema,
  options: SettingsSchemaOptions = {},
): ConformanceCheck[] {
  const notSecret = new Set(options.notSecret ?? []);
  return [
    {
      name: 'every settings field has a title and a description',
      run: () => {
        const missing = schemaFields(schema).flatMap(({ path, schema: sub }) => {
          const gaps = [
            typeof sub.title === 'string' && sub.title !== '' ? [] : ['title'],
            typeof sub.description === 'string' && sub.description !== '' ? [] : ['description'],
          ].flat();
          return gaps.length > 0 ? [`${path} (${gaps.join(', ')})`] : [];
        });
        assert(missing.length === 0, `settings fields missing: ${missing.join('; ')}`);
        return Promise.resolve();
      },
    },
    {
      name: 'credential settings fields are marked x-secret',
      run: () => {
        const unmarked = schemaFields(schema)
          .filter(({ path, schema: sub }) => {
            const name = path.split('.').at(-1) ?? path;
            return CREDENTIAL_NAME.test(name) && !notSecret.has(path) && !xSecret(sub);
          })
          .map(({ path }) => path);
        assert(unmarked.length === 0, `credential fields without x-secret: ${unmarked.join(', ')}`);
        return Promise.resolve();
      },
    },
  ];
}

/** Fixtures per type id; a type without fixtures gets only its manifest and settings checks. */
export interface PluginFixtures {
  sources?: Record<string, SourceFixtures>;
  destinations?: Record<string, DestinationFixtures>;
  notifiers?: Record<string, NotifierFixtures>;
  secretProviders?: Record<string, SecretProviderFixtures>;
  settings?: SettingsSchemaOptions;
}

function prefixed(prefix: string, checks: ConformanceCheck[]): ConformanceCheck[] {
  return checks.map((c) => ({ name: `${prefix}: ${c.name}`, run: () => c.run() }));
}

/**
 * The manifest check; with `fixtures`, also every type's settings-form checks and type checks,
 * run with the plugin's `capabilities.network` enforced, and a final check that no call left it.
 */
export function pluginConformanceChecks(
  plugin: PluginDefinition,
  fixtures?: PluginFixtures,
): ConformanceCheck[] {
  const manifest: ConformanceCheck = {
    name: `plugin ${plugin.id} manifest validates`,
    run: () => {
      const errors = validatePlugin(plugin);
      assert(errors.length === 0, errors.join('\n'));
      return Promise.resolve();
    },
  };
  if (!fixtures) return [manifest];

  const allowedHosts = plugin.capabilities.network ?? [];
  const violations: Violations = [];
  const settings = (schema: JSONSchema): ConformanceCheck[] =>
    settingsSchemaChecks(schema, fixtures.settings);
  const checks: ConformanceCheck[] = [manifest];
  for (const t of plugin.sources) {
    const f = fixtures.sources?.[t.id];
    checks.push(
      ...prefixed(`source ${t.id}`, [
        ...settings(t.settingsSchema),
        ...(f ? sourceChecks(t, { allowedHosts, ...f }, violations) : []),
      ]),
    );
  }
  for (const t of plugin.destinations) {
    const f = fixtures.destinations?.[t.id];
    checks.push(
      ...prefixed(`destination ${t.id}`, [
        ...settings(t.settingsSchema),
        ...(f ? destinationChecks(t, { allowedHosts, ...f }, violations) : []),
      ]),
    );
  }
  for (const t of plugin.notifiers) {
    const f = fixtures.notifiers?.[t.id];
    checks.push(
      ...prefixed(`notifier ${t.id}`, [
        ...settings(t.settingsSchema),
        ...(f ? notifierChecks(t, { allowedHosts, ...f }, violations) : []),
      ]),
    );
  }
  for (const t of plugin.secretProviders) {
    const f = fixtures.secretProviders?.[t.id];
    checks.push(
      ...prefixed(`secret provider ${t.id}`, [
        ...settings(t.settingsSchema),
        ...(f ? secretProviderConformanceChecks(t, f) : []),
      ]),
    );
  }
  checks.push({
    name: `plugin ${plugin.id} calls only the hosts in capabilities.network`,
    run: () => {
      assert(
        violations.length === 0,
        `calls outside capabilities.network: ${[...new Set(violations)].join('; ')}`,
      );
      return Promise.resolve();
    },
  });
  return checks;
}

interface TestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
}

/** Registers checks with any describe/it test runner, e.g. vitest's `{ describe, it }`. */
export function runConformance(title: string, checks: ConformanceCheck[], api: TestApi): void {
  api.describe(`conformance: ${title}`, () => {
    for (const check of checks) api.it(check.name, () => check.run());
  });
}
