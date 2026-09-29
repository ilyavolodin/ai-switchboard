import type { RawRequest } from '../types/common.js';

/** JSON-serialisable `RawRequest` for committed fixtures. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  body: string;
  receivedAt: string;
}

export function serializeRequest(req: RawRequest): RecordedRequest {
  return {
    method: req.method,
    path: req.path,
    headers: req.headers,
    query: req.query,
    body: req.body.toString('utf8'),
    receivedAt: req.receivedAt,
  };
}

export function deserializeRequest(rec: RecordedRequest): RawRequest {
  return { ...rec, body: Buffer.from(rec.body, 'utf8') };
}

export interface ScrubOptions {
  /** Replaced wherever they appear in headers or body. */
  secrets: string[];
  /** Removed outright (auth tokens, cookies). */
  dropHeaders?: string[];
  replacement?: string;
  /** Recompute signature headers over the scrubbed body so the fixture still verifies. */
  resign?: (body: Buffer) => Record<string, string>;
}

export function scrubRequest(req: RawRequest, options: ScrubOptions): RecordedRequest {
  const replacement = options.replacement ?? '[scrubbed]';
  const drop = new Set(
    (options.dropHeaders ?? ['authorization', 'cookie']).map((h) => h.toLowerCase()),
  );
  const scrub = (s: string): string =>
    options.secrets
      .filter((x) => x !== '')
      .reduce((acc, secret) => acc.split(secret).join(replacement), s);
  const body = Buffer.from(scrub(req.body.toString('utf8')), 'utf8');
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!drop.has(k)) headers[k] = v === undefined ? undefined : scrub(v);
  }
  Object.assign(headers, options.resign?.(body));
  return serializeRequest({ ...req, headers, body });
}
