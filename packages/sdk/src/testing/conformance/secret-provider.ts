import { isSecretNotFoundError, isWritableSecretProvider } from '../../errors.js';
import type { Settings } from '../../types/common.js';
import type { SecretProvider, SecretProviderType } from '../../types/notifier.js';
import type { StubHandler } from '../stubs.js';
import {
  assert,
  fail,
  healthCheck,
  testContext,
  typeManifestCheck,
  type ConformanceCheck,
  type Violations,
} from './shared.js';

export interface SecretProviderFixtures {
  /** Plain values: secret providers take no secret references themselves. */
  settings: Settings;
  /** Names the provider must list with these settings (the test seeds them first). */
  expectNames?: string[];
  /** Extra values that must never appear in the listing, besides every value `resolve` returns. */
  secrets?: string[];
  /** Stubs the provider's backend (a vault or cloud secret store); the default answers 404. */
  http?: StubHandler;
  /** The declared network capability; `pluginConformanceChecks` fills it from the plugin. */
  allowedHosts?: string[];
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
  fail(`resolve() ${when} still returns a value`);
}

function writableProviderChecks(
  type: SecretProviderType,
  fixtures: SecretProviderFixtures,
  violations: Violations,
): ConformanceCheck[] {
  const context = () => testContext(fixtures, violations).ctx;
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
  return secretProviderChecks(type, fixtures, []);
}

export function secretProviderChecks(
  type: SecretProviderType,
  fixtures: SecretProviderFixtures,
  violations: Violations,
): ConformanceCheck[] {
  const make = (): SecretProvider =>
    type.create(fixtures.settings, testContext(fixtures, violations).ctx);
  return [
    typeManifestCheck({ secretProviders: [type] }),
    healthCheck(make),
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
    ...writableProviderChecks(type, fixtures, violations),
  ];
}
