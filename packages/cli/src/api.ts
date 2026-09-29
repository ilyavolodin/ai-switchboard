import type { ApiError } from '@ai-switchboard/core/contract';
import { DEFAULT_PORT } from '@ai-switchboard/core/domain';

import type { CliDeps } from './deps.js';

export const DEFAULT_URL = `http://localhost:${String(DEFAULT_PORT)}`;

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
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

const HINTS: Partial<Record<number, string>> = {
  401: 'pass --token or set SWITCHBOARD_TOKEN (Settings → API tokens)',
  403: 'the token’s role is not allowed to do this',
};

export async function apiRequest(
  deps: Pick<CliDeps, 'fetch'>,
  server: ServerOptions,
  method: 'GET' | 'POST',
  path: string,
  init: { json?: unknown; accept?: string } = {},
): Promise<string> {
  const headers: Record<string, string> = { accept: init.accept ?? 'application/json' };
  if (server.token !== undefined) headers.authorization = `Bearer ${server.token}`;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await deps.fetch(`${server.url}/api/v1${path}`, {
      method,
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new ApiRequestError(0, `could not reach ${server.url}: ${cause}`);
  }
  const text = await res.text();
  if (res.ok) return text;

  let message = `${method} ${path} failed with HTTP ${res.status}`;
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
