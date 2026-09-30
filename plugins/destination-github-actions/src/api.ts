import {
  asObject,
  asString,
  errorText,
  InvokeError,
  isTransportError,
  parseRetryAfter,
  refusalFor,
  responseSnippet,
  tryJson,
  type HttpRequest,
  type HttpResponse,
  type InvokeResult,
  type PluginContext,
} from '@ai-switchboard/sdk';

import { createAuth, GITHUB_HEADERS, GithubAuthError } from './auth.js';
import { GITHUB_API, type GithubActionsSettings } from './settings.js';

export function messageOf(res: HttpResponse): string {
  return asString(asObject(tryJson(res))?.message) ?? responseSnippet(res);
}

/** GitHub signals rate limits with 429, or 403 and `x-ratelimit-remaining: 0`. */
function isRateLimited(res: HttpResponse): boolean {
  return (
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers['x-ratelimit-remaining'] === '0' || /rate limit/i.test(messageOf(res))))
  );
}

function retryAfterSeconds(res: HttpResponse, now: Date): number | undefined {
  const retryAfter = parseRetryAfter(res.headers['retry-after'], now);
  if (retryAfter !== undefined) return retryAfter;
  const reset = Number(res.headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, Math.ceil(reset - now.getTime() / 1000));
  }
  return undefined;
}

/**
 * Rate limits are returned; everything else throws. 404 (no such workflow or no access), 422 (no
 * workflow_dispatch trigger, unknown input, bad ref) and the other 4xx repeat on retry, so they
 * are definitive.
 */
export function refusal(res: HttpResponse, now: Date): InvokeResult {
  return refusalFor(res, now, {
    message: (r) => `GitHub answered ${r.status} to the dispatch: ${messageOf(r)}`,
    isRateLimited,
    retryAfterSeconds,
  });
}

export const repoPath = (owner: string, repo: string): string =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export interface GithubApi {
  /** `req.url` is a path under the API root. A 401 drops the cached installation token. */
  request(req: HttpRequest): Promise<HttpResponse>;
  /**
   * Gets a token before a dispatch. A token failure happens before the dispatch is sent, so it
   * is thrown as an `InvokeError` that is definitive (a 4xx) or safe to retry.
   */
  tokenOrThrow(): Promise<void>;
}

export function createApi(settings: GithubActionsSettings, ctx: PluginContext): GithubApi {
  const auth = createAuth(settings, ctx);

  async function request(req: HttpRequest): Promise<HttpResponse> {
    const token = await auth.token();
    const res = await ctx.http.request({
      ...req,
      url: `${GITHUB_API}${req.url}`,
      headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}`, ...req.headers },
    });
    if (res.status === 401) auth.invalidate();
    return res;
  }

  async function tokenOrThrow(): Promise<void> {
    try {
      await auth.token();
    } catch (err) {
      const message = errorText(err);
      if (err instanceof GithubAuthError && err.status !== undefined && err.status < 500) {
        throw new InvokeError(message, { status: err.status, definitive: true, cause: err });
      }
      if (err instanceof GithubAuthError && err.status === undefined) {
        throw new InvokeError(message, { definitive: true, cause: err });
      }
      if (isTransportError(err) || err instanceof GithubAuthError) {
        throw new InvokeError(`Could not get a GitHub token: ${message}`, {
          sent: false,
          cause: err,
        });
      }
      throw err;
    }
  }

  return { request, tokenOrThrow };
}
