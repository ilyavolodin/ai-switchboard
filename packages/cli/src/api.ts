import type { ApiError, ApiRoute, ApiRoutes } from '@ai-switchboard/core/contract';
import { DEFAULT_PORT } from '@ai-switchboard/core/domain';
import { errorText, isRecord } from '@ai-switchboard/sdk/json';

import type { CliDeps } from './deps.js';

export const DEFAULT_URL = `http://localhost:${String(DEFAULT_PORT)}`;

type Strip<K> = K extends `${infer M} /api/v1${infer P}` ? `${M} ${P}` : never;
type Routes = { [K in ApiRoute as Strip<K>]: ApiRoutes[K] };

/** An API route without path parameters, keyed without `/api/v1`: `'POST /apply'`. */
export type Route = Exclude<keyof Routes, `${string}/:${string}`>;
export type RouteBody<R extends Route> = Routes[R] extends { body: infer B } ? B : undefined;
export type RouteRes<R extends Route> = Routes[R]['res'];

export interface ServerOptions {
  url: string;
  token: string | undefined;
}

/** Falls back to `SWITCHBOARD_URL` / `SWITCHBOARD_TOKEN`. */
export function serverOptions(
  opts: { url?: string; token?: string },
  env: NodeJS.ProcessEnv,
): ServerOptions {
  const url = (opts.url ?? env.SWITCHBOARD_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  const token = opts.token ?? env.SWITCHBOARD_TOKEN;
  return { url, token: token === '' ? undefined : token };
}

export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  constructor(
    readonly status: number,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

function isApiError(value: unknown): value is ApiError {
  return isRecord(value) && typeof value.message === 'string';
}

const HINTS: Partial<Record<number, string>> = {
  401: 'pass --token or set SWITCHBOARD_TOKEN (Settings → API tokens)',
  403: 'the token’s role is not allowed to do this',
};

/** The response text of a 2xx; anything else throws an `ApiRequestError` with the API's message. */
export async function apiRequest<R extends Route>(
  deps: Pick<CliDeps, 'fetch'>,
  server: ServerOptions,
  route: R,
  init: { body?: RouteBody<R>; accept?: string } = {},
): Promise<string> {
  const [method = 'GET', path = ''] = route.split(' ');
  const headers: Record<string, string> = { accept: init.accept ?? 'application/json' };
  if (server.token !== undefined) headers.authorization = `Bearer ${server.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await deps.fetch(`${server.url}/api/v1${path}`, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    throw new ApiRequestError(0, `could not reach ${server.url}: ${errorText(err)}`);
  }
  const text = await res.text();
  if (res.ok) return text;

  let message = `${route} failed with HTTP ${res.status}`;
  let details: string[] = [];
  try {
    const body: unknown = JSON.parse(text);
    if (isApiError(body)) {
      message = `${message}: ${body.message}`;
      details = body.details ?? [];
    }
  } catch {
    if (text.trim() !== '') message = `${message}: ${text.trim().slice(0, 200)}`;
  }
  const hint = HINTS[res.status];
  throw new ApiRequestError(
    res.status,
    hint !== undefined ? `${message} (${hint})` : message,
    details,
  );
}

/** `apiRequest` for a JSON route: the body parsed and checked with `isResponse`. */
export async function apiJson<R extends Route>(
  deps: Pick<CliDeps, 'fetch'>,
  server: ServerOptions,
  route: R,
  isResponse: (value: unknown) => value is RouteRes<R>,
  init: { body?: RouteBody<R> } = {},
): Promise<RouteRes<R>> {
  const text = await apiRequest(deps, server, route, init);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${server.url} returned a non-JSON answer to ${route}; is --url right?`);
  }
  if (!isResponse(body)) throw new Error(`${server.url} returned an unexpected answer to ${route}`);
  return body;
}
