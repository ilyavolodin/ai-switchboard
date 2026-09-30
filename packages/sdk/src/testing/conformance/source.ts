import { isValidSchema, validateAgainst } from '../../schema/index.js';
import type { RawRequest, Settings } from '../../types/common.js';
import type { ArtifactRef, EventDraft, EventTypeSpec } from '../../types/events.js';
import type { Source, SourceType } from '../../types/source.js';
import type { StubHandler } from '../stubs.js';
import {
  assert,
  healthCheck,
  testContext,
  typeManifestCheck,
  type ConformanceCheck,
  type Violations,
} from './shared.js';

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

function pushChecks(
  type: SourceType,
  push: NonNullable<SourceFixtures['push']>,
  make: () => Source,
  specs: () => EventTypeSpec[],
  secrets: string[],
): ConformanceCheck[] {
  return [
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
  ];
}

export function sourceChecks(
  type: SourceType,
  fixtures: SourceFixtures,
  violations: Violations,
): ConformanceCheck[] {
  const make = (): Source => type.create(fixtures.settings, testContext(fixtures, violations).ctx);
  const secrets = fixtures.secrets ?? [];
  const specs = (): EventTypeSpec[] => eventTypesFor(type, fixtures.settings);
  const checks: ConformanceCheck[] = [
    typeManifestCheck({ sources: [type] }),
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
    healthCheck(make),
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
    if (push) checks.push(...pushChecks(type, push, make, specs, secrets));
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
