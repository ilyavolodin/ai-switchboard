import { CapabilityError, TransportError } from './errors.js';
import type { Logger } from './logger.js';

export interface HttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Raw body. Mutually exclusive with `json`. */
  body?: string | Uint8Array;
  /** Serialised as JSON with `content-type: application/json`. */
  json?: unknown;
  /** Defaults to the client's timeout (30 s). */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  get(url: string, options?: Omit<HttpRequest, 'url' | 'method'>): Promise<HttpResponse>;
  post(url: string, options?: Omit<HttpRequest, 'url' | 'method'>): Promise<HttpResponse>;
}

export interface HttpClientOptions {
  /** Host globs from the plugin's declared network capability. Omitted = no restriction. */
  allowedHosts?: string[];
  timeoutMs?: number;
  logger?: Logger;
  /** Extra headers per request, e.g. W3C `traceparent` from the core's tracer. */
  injectHeaders?: () => Record<string, string>;
  /** Replace the transport (tests). */
  fetch?: typeof fetch;
}

/** Error codes that mean the connection was never established, so nothing was sent. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_INVALID_URL',
]);

/** `*.atlassian.net` matches `acme.atlassian.net` (not `atlassian.net`); `*` matches all. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

export function makeResponse(
  status: number,
  headers: Record<string, string>,
  body: Buffer,
): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body,
    text: () => body.toString('utf8'),
    json: <T>() => JSON.parse(body.toString('utf8')) as T,
  };
}

function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const defaultTimeout = options.timeoutMs ?? 30_000;

  async function request(req: HttpRequest): Promise<HttpResponse> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch (cause) {
      throw new TransportError(`Invalid URL: ${req.url}`, {
        sent: false,
        code: 'ERR_INVALID_URL',
        cause,
      });
    }
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (options.allowedHosts && !options.allowedHosts.some((p) => hostMatches(url.hostname, p))) {
      throw new CapabilityError(
        `Host ${url.hostname} is not in the plugin's declared network capability (${options.allowedHosts.join(', ')})`,
      );
    }
    const headers: Record<string, string> = { ...options.injectHeaders?.(), ...req.headers };
    let body: string | Uint8Array | undefined = req.body;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['content-type'] ??= 'application/json';
    }
    const method = (req.method ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
    const started = Date.now();
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body: body as string | Uint8Array<ArrayBuffer> | undefined,
        signal: AbortSignal.timeout(req.timeoutMs ?? defaultTimeout),
      });
    } catch (cause) {
      const code = errorCode(cause) ?? (cause instanceof Error ? cause.name : undefined);
      const sent = !(code !== undefined && NOT_SENT_CODES.has(code));
      options.logger?.warn('http request failed', { method, host: url.hostname, code, sent });
      throw new TransportError(
        `${method} ${url.hostname}${url.pathname} failed: ${code ?? 'error'}`,
        {
          sent,
          ...(code !== undefined ? { code } : {}),
          cause,
        },
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });
    options.logger?.debug('http request', {
      method,
      host: url.hostname,
      path: url.pathname,
      status: res.status,
      ms: Date.now() - started,
    });
    return makeResponse(res.status, resHeaders, buf);
  }

  return {
    request,
    get: (url, opts) => request({ ...opts, url, method: 'GET' }),
    post: (url, opts) => request({ ...opts, url, method: 'POST' }),
  };
}

/** Parse a `Retry-After` header (seconds or HTTP date) into seconds from `now`. */
export function parseRetryAfter(
  value: string | undefined,
  now: Date = new Date(),
): number | undefined {
  if (value == null || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.round((date - now.getTime()) / 1000));
}
