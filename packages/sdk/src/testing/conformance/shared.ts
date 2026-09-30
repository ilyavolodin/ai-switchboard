import { HEALTH_STATUSES } from '../../constants.js';
import { isCapabilityError } from '../../errors.js';
import type { HttpClient } from '../../http.js';
import { isOneOf } from '../../json.js';
import {
  definePlugin,
  validatePlugin,
  type PluginDefinition,
  type PluginSpec,
} from '../../plugin.js';
import type { Health } from '../../types/common.js';
import { createStubHttp, createTestContext, type StubHandler } from '../stubs.js';

/** One named conformance check; `run` throws with a message on failure. */
export interface ConformanceCheck {
  name: string;
  run(): Promise<void>;
}

export class ConformanceFailure extends Error {
  override readonly name = 'ConformanceFailure';
}

/** Where calls outside the declared network capability are recorded. */
export type Violations = string[];

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

/** A stubbed client that enforces `allowedHosts` and records calls outside it in `violations`. */
export function testHttp(
  handler: StubHandler | undefined,
  allowedHosts: string[] | undefined,
  violations: Violations,
): { client: HttpClient; calls: () => number } {
  const stub = createStubHttp(handler, allowedHosts);
  return { client: guarded(stub.client, violations), calls: () => stub.calls.length };
}

/** A test context whose `http` is `testHttp(...)`. */
export function testContext(
  fixtures: { http?: StubHandler; allowedHosts?: string[]; now?: () => Date },
  violations: Violations,
  handler: StubHandler | undefined = fixtures.http,
): { ctx: ReturnType<typeof createTestContext>; calls: () => number } {
  const http = testHttp(handler, fixtures.allowedHosts, violations);
  const ctx = createTestContext({
    http: http.client,
    ...(fixtures.now ? { now: fixtures.now } : {}),
  });
  return { ctx, calls: http.calls };
}

export function fail(message: string): never {
  throw new ConformanceFailure(message);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

/** Built lazily so a manifest that makes `definePlugin` throw fails this check, not the suite. */
export function manifestCheck(
  plugin: () => PluginDefinition,
  name = 'manifest validates',
): ConformanceCheck {
  return {
    name,
    run: () => {
      const errors = validatePlugin(plugin());
      assert(errors.length === 0, errors.join('\n'));
      return Promise.resolve();
    },
  };
}

/** The manifest check for one type, wrapped in a throwaway plugin. */
export function typeManifestCheck(
  types: Pick<PluginSpec, 'sources' | 'destinations' | 'notifiers' | 'secretProviders'>,
): ConformanceCheck {
  return manifestCheck(() =>
    definePlugin({ id: 'conformance', displayName: 'Conformance', ...types }),
  );
}

export function healthCheck(make: () => { health(): Promise<Health> }): ConformanceCheck {
  return {
    name: 'health() resolves to a Health',
    run: async () => {
      const h = await make().health();
      assert(isOneOf(HEALTH_STATUSES, h.status), 'health status is invalid');
    },
  };
}
