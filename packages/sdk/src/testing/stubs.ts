import { createHttpClient, type HttpClient } from '../http.js';
import { createMemoryLogger, type MemoryLogEntry } from '../logger.js';
import type { RawRequest } from '../types/common.js';
import { SECRET_KEY_PATTERN, SecretStoreError } from '../errors.js';
import type {
  InstanceSecrets,
  InstanceState,
  PluginContext,
  SecretStoreStatus,
} from '../types/context.js';
import type { RunHandle } from '../types/destination.js';

export interface StubRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  json<T = unknown>(): T;
}

export interface StubReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
}

/** `undefined` gives a 404. Throw an error with `code` to simulate a network failure. */
export type StubHandler = (
  req: StubRequest,
) => StubReply | undefined | Promise<StubReply | undefined>;

export interface StubHttp {
  client: HttpClient;
  calls: StubRequest[];
  fetch: typeof fetch;
}

/** Records every call. */
export function createStubHttp(
  handler: StubHandler = () => undefined,
  allowedHosts?: string[],
): StubHttp {
  const calls: StubRequest[] = [];
  const stubFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body =
      init?.body == null
        ? ''
        : typeof init.body === 'string'
          ? init.body
          : Buffer.from(init.body as Uint8Array).toString('utf8');
    const req: StubRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers,
      body,
      json: <T>() => JSON.parse(body) as T,
    };
    calls.push(req);
    const reply = await handler(req);
    if (!reply) return new Response('not found', { status: 404 });
    const resHeaders = new Headers(reply.headers);
    let resBody = reply.body ?? '';
    if (reply.json !== undefined) {
      resBody = JSON.stringify(reply.json);
      if (!resHeaders.has('content-type')) resHeaders.set('content-type', 'application/json');
    }
    const status = reply.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : resBody, {
      status,
      headers: resHeaders,
    });
  }) as typeof fetch;
  return {
    client: createHttpClient({ fetch: stubFetch, ...(allowedHosts ? { allowedHosts } : {}) }),
    calls,
    fetch: stubFetch,
  };
}

export function createMemoryState(
  initial: Record<string, unknown> = {},
): InstanceState & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: <T>(key: string) => Promise.resolve(data[key] as T | undefined),
    set: (key: string, value: unknown) => {
      data[key] = value;
      return Promise.resolve();
    },
  };
}

/**
 * `ctx.secrets` in memory. `writable: false` behaves like an instance whose settings reference
 * only read-only providers: `set` and `delete` throw `SecretStoreError`.
 */
export function createMemorySecrets(
  initial: Record<string, string> = {},
  options: { writable?: boolean } = {},
): InstanceSecrets & { data: Record<string, string> } {
  const data = { ...initial };
  const status: SecretStoreStatus =
    options.writable === false
      ? { writable: false, reason: 'no writable secret provider (test)' }
      : { writable: true, provider: 'memory' };
  const checkKey = (key: string): void => {
    if (!SECRET_KEY_PATTERN.test(key)) throw new SecretStoreError(`"${key}" is not a valid key`);
  };
  const writable = (): void => {
    if (!status.writable) throw new SecretStoreError(status.reason);
  };
  return {
    data,
    get: (key) => {
      checkKey(key);
      return Promise.resolve(data[key]);
    },
    set: (key, value) => {
      checkKey(key);
      writable();
      data[key] = value;
      return Promise.resolve();
    },
    delete: (key) => {
      checkKey(key);
      writable();
      Reflect.deleteProperty(data, key);
      return Promise.resolve();
    },
    check: () => Promise.resolve(status),
  };
}

export interface TestContextOptions {
  http?: HttpClient;
  now?: () => Date;
  instanceId?: string;
  publicUrl?: string;
  state?: InstanceState;
  secrets?: InstanceSecrets;
}

const wallClock = (): Date => new Date();

export function createTestContext(
  options: TestContextOptions = {},
): PluginContext & { logs: MemoryLogEntry[] } {
  const logger = createMemoryLogger();
  return {
    instanceId: options.instanceId ?? 'test-instance',
    instanceName: 'Test instance',
    logger,
    logs: logger.entries,
    http: options.http ?? createStubHttp().client,
    now: options.now ?? wallClock,
    publicUrl: options.publicUrl ?? 'https://switchboard.test',
    state: options.state ?? createMemoryState(),
    secrets: options.secrets ?? createMemorySecrets(),
  };
}

export interface RawRequestInit {
  method?: string;
  path?: string;
  headers?: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
  body?: string | Buffer | object;
  receivedAt?: string;
  /** Stamps `receivedAt` when it is not given; defaults to the wall clock. */
  now?: () => Date;
}

/** Objects are JSON-encoded; header names are lower-cased. */
export function rawRequest(init: RawRequestInit = {}): RawRequest {
  const body =
    init.body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(init.body)
        ? init.body
        : Buffer.from(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
  return {
    method: init.method ?? 'POST',
    path: init.path ?? '/hooks/test-instance',
    headers,
    query: init.query ?? {},
    body,
    receivedAt: init.receivedAt ?? (init.now ?? wallClock)().toISOString(),
  };
}

/** The deadline is an hour after `options.now` (default the wall clock) unless overridden. */
export function runHandle(
  overrides: Partial<RunHandle> = {},
  options: { now?: () => Date } = {},
): RunHandle {
  const now = (options.now ?? wallClock)();
  return {
    id: '00000000-0000-4000-8000-000000000001',
    processId: 'process-1',
    processName: 'Test process',
    mode: 'event',
    dryRun: false,
    callbackUrl: 'https://switchboard.test/callbacks/test-instance',
    deadline: new Date(now.getTime() + 3_600_000).toISOString(),
    ...overrides,
  };
}
