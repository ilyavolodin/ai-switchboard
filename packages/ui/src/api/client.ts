import type { ApiError, ApiRoute, ApiRoutes } from '@ai-switchboard/core/contract';

export const API_BASE = '/api/v1';

type Strip<K> = K extends `${infer M} /api/v1${infer P}` ? `${M} ${P}` : never;

/** `ApiRoutes` keyed without the `/api/v1` prefix: `'GET /processes/:id'`. */
export type Routes = { [K in ApiRoute as Strip<K>]: ApiRoutes[K] };
export type Route = keyof Routes;

type Method<R> = R extends `${infer M} ${string}` ? M : never;
type PathOf<R> = R extends `${string} ${infer P}` ? P : never;
type ParamsIn<P> = P extends `${string}:${infer N}/${infer Rest}`
  ? N | ParamsIn<`/${Rest}`>
  : P extends `${string}:${infer N}`
    ? N
    : never;

export type PathParam<R extends Route> = ParamsIn<PathOf<R>>;
export type RouteParams<R extends Route> = {
  [N in PathParam<R>]: N extends 'version' ? number : string;
};
export type RouteBody<R extends Route> = Routes[R] extends { body: infer B } ? B : undefined;
export type RouteQuery<R extends Route> = Routes[R] extends { query: infer Q } ? Q : undefined;
export type RouteRes<R extends Route> = Routes[R]['res'];
export type MutationRoute = { [R in Route]: Method<R> extends 'GET' ? never : R }[Route];

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

export type ApiFetchOptions<R extends Route> = ([PathParam<R>] extends [never]
  ? { params?: undefined }
  : { params: RouteParams<R> }) & {
  body?: RouteBody<R>;
  query?: RouteQuery<R>;
  signal?: AbortSignal;
};

type FetchArgs<R extends Route> = [PathParam<R>] extends [never]
  ? [options?: ApiFetchOptions<R>]
  : [options: ApiFetchOptions<R>];

function buildQuery(query: object | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query) as [string, QueryValue][]) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Path parameter names in route order: `'POST /processes/:id/run'` → `['id']`. */
export function routeParamNames(route: Route): string[] {
  return [...route.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] ?? '');
}

export function routePath(route: Route, params: Record<string, string | number> = {}): string {
  const path = route.slice(route.indexOf(' ') + 1);
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) =>
    encodeURIComponent(String(params[name] ?? '')),
  );
}

/** Throws `ApiRequestError` for any non-2xx response; a 204 resolves to `undefined`. */
export async function apiFetch<R extends Route>(
  route: R,
  ...[options]: FetchArgs<R>
): Promise<RouteRes<R>> {
  const { params, body, query, signal } = (options ?? {}) as {
    params?: Record<string, string | number>;
    body?: unknown;
    query?: object;
    signal?: AbortSignal;
  };
  const method = route.slice(0, route.indexOf(' '));
  const as = route === 'GET /export' ? 'text' : 'json';
  const url = `${API_BASE}${routePath(route, params)}${buildQuery(query)}`;
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
  if (res.status === 204) return undefined;
  if (as === 'text') return await res.text();
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as RouteRes<R>;
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
