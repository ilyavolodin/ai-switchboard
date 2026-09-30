import type { HttpRequest, HttpResponse } from '@ai-switchboard/sdk';

import type { PollHttpSettings } from './settings.js';

export class PollError extends Error {
  override readonly name = 'PollError';
}

export function authHeaders(s: PollHttpSettings): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...s.headers };
  if (s.token !== undefined && s.token !== '') {
    const header = s.tokenHeader.toLowerCase();
    const scheme = s.authScheme.trim();
    headers[header] =
      header === 'authorization' && scheme !== '' ? `${scheme} ${s.token}` : s.token;
  }
  return headers;
}

/** The poll request, with the cursor in the query or the JSON body as the settings say. */
export function buildRequest(s: PollHttpSettings, cursor: string | null): HttpRequest {
  const req: HttpRequest = { method: s.method, url: s.url, headers: authHeaders(s) };
  const param = s.cursorParam;
  const withCursor = param !== undefined && param !== '' && cursor !== null;
  if (withCursor && s.cursorIn === 'query') req.query = { [param]: cursor };
  if (s.method === 'POST') {
    req.json =
      withCursor && s.cursorIn === 'body' ? { ...s.body, [param]: cursor } : (s.body ?? {});
  }
  return req;
}

/** The body as JSON (`null` when empty); throws `PollError` for a refusal or a non-JSON body. */
export function readJson(res: HttpResponse, host: string): unknown {
  if (!res.ok) throw new PollError(`${host} answered ${res.status}`);
  const text = res.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PollError(`${host} did not answer with JSON`);
  }
}
