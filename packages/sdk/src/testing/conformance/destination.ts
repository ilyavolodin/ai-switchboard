import { INVOKE_STATUSES, RUN_STATES } from '../../constants.js';
import { isOneOf } from '../../json.js';
import { isValidSchema } from '../../schema/index.js';
import type { RawRequest, Settings } from '../../types/common.js';
import type {
  Destination,
  DestinationType,
  Input,
  InvokeResult,
  RunHandle,
  Target,
  TrackingMode,
  UsageReport,
} from '../../types/destination.js';
import { runHandle, type StubHandler } from '../stubs.js';
import {
  assert,
  testContext,
  typeManifestCheck,
  type ConformanceCheck,
  type Violations,
} from './shared.js';

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

export function destinationChecks(
  type: DestinationType,
  fixtures: DestinationFixtures,
  violations: Violations,
): ConformanceCheck[] {
  const example = type.examples?.[0];
  const target = fixtures.target ?? example?.target;
  const input = fixtures.input ?? example?.input;
  const make = (): Destination =>
    type.create(fixtures.settings, testContext(fixtures, violations).ctx);
  const tracking = (): TrackingMode =>
    type.trackingFor ? type.trackingFor(target) : type.tracking;

  return [
    typeManifestCheck({ destinations: [type] }),
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
        const handle = runHandle(fixtures.run, fixtures.now ? { now: fixtures.now } : {});
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
