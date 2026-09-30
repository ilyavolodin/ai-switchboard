import {
  asObject,
  asString,
  refusalFor,
  responseSnippet,
  tryJson,
  type HttpClient,
  type HttpResponse,
  type InvokeResult,
} from '@ai-switchboard/sdk';

import type { RoutinesSettings } from './settings.js';

export const ANTHROPIC_VERSION = '2023-06-01';
export const OAUTH_BETA = 'oauth-2025-04-20';

/** Anthropic errors look like `{ type: 'error', error: { type, message } }`. */
export function errorMessage(res: HttpResponse): string {
  const error = asObject(tryJson(res))?.error;
  return asString(asObject(error)?.message) ?? asString(error) ?? responseSnippet(res);
}

/** Returns a result for 429 and held states; throws for the rest. */
export function refusal(res: HttpResponse, now: Date): InvokeResult {
  return refusalFor(res, now, {
    message: (r) => `Routines API answered ${r.status}: ${errorMessage(r)}`,
    rateLimitMessage: (r) => `Routines API rate limit: ${errorMessage(r)}`,
    held: (r) => {
      if (r.status !== 400 && r.status !== 409) return undefined;
      const message = errorMessage(r);
      if (/\bpaused\b/i.test(message)) return 'paused';
      return /\bdisabled\b/i.test(message) ? 'disabled' : undefined;
    },
    // 529 is Anthropic's "overloaded": the request was not processed, so it is as safe to retry as a 503.
    retryableStatuses: [529],
  });
}

export interface RoutinesApi {
  fire(routineId: string, text: string): Promise<HttpResponse>;
  /** The seat's usage windows, read with an OAuth access token. */
  usage(url: string, accessToken: string): Promise<HttpResponse>;
}

export function createApi(
  http: HttpClient,
  settings: Pick<RoutinesSettings, 'apiBaseUrl' | 'token' | 'betaHeader'>,
): RoutinesApi {
  const base = settings.apiBaseUrl.replace(/\/+$/, '');
  return {
    fire: (routineId, text) =>
      http.post(`${base}/v1/claude_code/routines/${encodeURIComponent(routineId)}/fire`, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${settings.token}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': settings.betaHeader,
        },
        json: { text },
      }),
    usage: (url, accessToken) =>
      http.get(url, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'anthropic-beta': OAUTH_BETA,
        },
      }),
  };
}
