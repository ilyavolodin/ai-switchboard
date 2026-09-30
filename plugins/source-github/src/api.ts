import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

import {
  asObject,
  asString,
  errorText,
  tryJson,
  type HttpClient,
  type HttpResponse,
  type PluginContext,
} from '@ai-switchboard/sdk';

import type { GitHubSettings } from './settings.js';

export const API_BASE = 'https://api.github.com';

/** Installation tokens live an hour; refresh this long before they expire. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** A token minted this recently is used even when GitHub gave it a shorter life than the margin. */
const FRESH_MS = 30_000;
/** GitHub accepts App JWTs of at most 10 minutes; backdate `iat` a minute for clock drift. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 600;

export const MARK_READY = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } }
}`;

export class GitHubAuthError extends Error {
  override readonly name = 'GitHubAuthError';
}

/** GitHub answered a lookup with something other than the item or a 404. */
export class GitHubApiError extends Error {
  override readonly name = 'GitHubApiError';
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * A PEM key pasted into an environment variable often arrives with literal `\n` sequences;
 * restore them so `createPrivateKey` accepts it.
 */
function loadKey(pem: string): KeyObject {
  const normalised = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  try {
    return createPrivateKey(normalised.trim());
  } catch (err) {
    throw new GitHubAuthError(`The App private key is not a valid PEM key: ${errorText(err)}`);
  }
}

/** A numeric App ID goes in `iss` as a number; a Client ID as the string it is. */
export function jwtIssuer(appId: string): string | number {
  return /^\d+$/.test(appId) ? Number(appId) : appId;
}

export function appJwt(appId: string, key: KeyObject, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - JWT_BACKDATE_S;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat, exp: iat + JWT_LIFETIME_S, iss: jwtIssuer(appId) }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}

const BASE_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'ai-switchboard',
};

export interface GitHubAuth {
  authorization(): Promise<string>;
  /** Drop a cached installation token (after a 401). */
  invalidate(): void;
}

export function errorMessage(res: HttpResponse): string {
  return asString(asObject(tryJson(res))?.message) ?? `HTTP ${res.status}`;
}

/** App installation tokens are cached in memory (never in `ctx.state`). */
export function createAuth(s: GitHubSettings, ctx: PluginContext): GitHubAuth {
  if (s.authMode === 'token') {
    const header = `Bearer ${s.token ?? ''}`;
    return { authorization: () => Promise.resolve(header), invalidate: () => undefined };
  }
  const appId = s.appId ?? '';
  const installationId = s.installationId ?? '';
  let key: KeyObject | undefined;
  let cached: { header: string; expiresAt: number; mintedAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  const appAuthorization = (): string => {
    key ??= loadKey(s.privateKey ?? '');
    return `Bearer ${appJwt(appId, key, ctx.now())}`;
  };

  async function exchange(): Promise<string> {
    const res = await ctx.http.post(
      `${API_BASE}/app/installations/${installationId}/access_tokens`,
      { headers: { ...BASE_HEADERS, authorization: appAuthorization() } },
    );
    if (!res.ok) {
      throw new GitHubAuthError(
        `GitHub refused the installation token (${res.status}): ${errorMessage(res)}`,
      );
    }
    const body = asObject(tryJson(res));
    const token = asString(body?.token);
    const expiresAt = Date.parse(asString(body?.expires_at) ?? '');
    if (token === undefined || Number.isNaN(expiresAt)) {
      throw new GitHubAuthError('GitHub returned an installation token response without a token');
    }
    cached = { header: `Bearer ${token}`, expiresAt, mintedAt: ctx.now().getTime() };
    return cached.header;
  }

  return {
    authorization() {
      const now = ctx.now().getTime();
      if (
        cached &&
        (cached.expiresAt - TOKEN_MARGIN_MS > now || now - cached.mintedAt < FRESH_MS) &&
        cached.expiresAt > now
      ) {
        return Promise.resolve(cached.header);
      }
      inflight ??= exchange().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

export interface GitHubApi {
  /** A 401 drops the cached installation token. */
  request(method: string, path: string, json?: unknown): Promise<HttpResponse>;
  graphql(query: string, variables: Record<string, unknown>): Promise<HttpResponse>;
}

export function createApi(http: HttpClient, auth: GitHubAuth): GitHubApi {
  async function request(method: string, path: string, json?: unknown): Promise<HttpResponse> {
    const headers = { ...BASE_HEADERS, authorization: await auth.authorization() };
    const res = await http.request({
      method,
      url: `${API_BASE}${path}`,
      headers,
      ...(json !== undefined ? { json } : {}),
    });
    if (res.status === 401) auth.invalidate();
    return res;
  }
  return {
    request,
    graphql: (query, variables) => request('POST', '/graphql', { query, variables }),
  };
}
