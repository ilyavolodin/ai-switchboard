import type { ApiError } from '@ai-switchboard/core/contract';

export const API_BASE = '/api/v1';

/** `body` is synthesised when the response was not JSON. */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.message || `Request failed with ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Duck-typed guard (works across bundles and realms). */
export function isApiRequestError(e: unknown): e is ApiRequestError {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'ApiRequestError' &&
    typeof (e as { status?: unknown }).status === 'number'
  );
}

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  as?: 'json' | 'text';
}

export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Throws `ApiRequestError` for any non-2xx response; a 204 resolves to `undefined`. */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, as = 'json' } = options;
  const url = `${API_BASE}${path}${buildQuery(query)}`;
  const headers: Record<string, string> = {
    accept: as === 'text' ? 'text/yaml, */*' : 'application/json',
  };
  const init: RequestInit = { method, credentials: 'include', headers };
  if (signal) init.signal = signal;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new ApiRequestError(res.status, await readError(res));
  if (res.status === 204) return undefined as T;
  if (as === 'text') return (await res.text()) as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function readError(res: Response): Promise<ApiError> {
  const fallback: ApiError = {
    error: `http_${res.status}`,
    message: res.statusText || 'Request failed',
  };
  try {
    const text = await res.text();
    if (!text) return fallback;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
      const p = parsed as Partial<ApiError>;
      return {
        error: typeof p.error === 'string' ? p.error : fallback.error,
        message: typeof p.message === 'string' ? p.message : fallback.message,
        ...(Array.isArray(p.details) ? { details: p.details.map(String) } : {}),
        ...(Array.isArray(p.usedBy) ? { usedBy: p.usedBy.filter(isProcessRef) } : {}),
      };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function isProcessRef(v: unknown): v is { id: string; name: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { id?: unknown }).id === 'string' &&
    typeof (v as { name?: unknown }).name === 'string'
  );
}

/** The processes named by a 409 "still used by" refusal, or null for any other error. */
export function usedByOf(e: unknown): { id: string; name: string }[] | null {
  if (!isApiRequestError(e) || e.status !== 409) return null;
  const used = e.body.usedBy;
  return used && used.length > 0 ? used : null;
}

export function errorMessage(e: unknown): string {
  if (isApiRequestError(e)) {
    const details = e.body.details?.length ? ` — ${e.body.details.join('; ')}` : '';
    return `${e.body.message}${details}`;
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
