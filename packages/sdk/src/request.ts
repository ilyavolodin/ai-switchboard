import type { HttpResponse } from './http.js';
import type { RawRequest } from './types/common.js';

/** A request header's value; `undefined` when it is missing or empty. `name` is lower-case. */
export function headerValue(req: RawRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return value === undefined || value === '' ? undefined : value;
}

export const RESPONSE_SNIPPET_CHARS = 200;

/** The start of a response body for an error message, trimmed; `''` for an empty body. */
export function responseSnippet(res: HttpResponse, max = RESPONSE_SNIPPET_CHARS): string {
  const text = res.text().trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Header names lower-cased, as `HttpClient` and `RawRequest` carry them. */
export function lowerCaseHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}
