import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

import type { HttpClient, HttpResponse, PluginContext } from '@ai-switchboard/sdk';

import { obj, str } from './json.js';
import type { GitHubSettings } from './settings.js';

export const API_BASE = 'https://api.github.com';

/** Refresh an installation token this long before GitHub says it expires. */
const REFRESH_MARGIN_MS = 60_000;
/** GitHub accepts App JWTs of at most 10 minutes; backdate `iat` for clock drift. */
const JWT_LIFETIME_S = 540;
const JWT_BACKDATE_S = 60;

/** Thrown when a token cannot be obtained (bad key, wrong installation, revoked App). */
export class GitHubAuthError extends Error {
  override readonly name = 'GitHubAuthError';
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
    throw new GitHubAuthError(
      `The App private key is not a valid PEM key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** An RS256 JWT identifying the App, as GitHub's App authentication requires. */
export function appJwt(appId: string, key: KeyObject, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - JWT_BACKDATE_S;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_S, iss: appId }));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}

const BASE_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'ai-switchboard',
};

/** Supplies the `authorization` header value for API calls. */
export interface GitHubAuth {
  authorization(): Promise<string>;
}

/**
 * Token mode hands out the PAT. App mode signs a JWT, exchanges it for an installation token and
 * caches that token in memory (never in `ctx.state`) until a minute before it expires.
 */
export function createAuth(s: GitHubSettings, ctx: PluginContext): GitHubAuth {
  if (s.authMode === 'token') {
    const header = `Bearer ${s.token ?? ''}`;
    return { authorization: () => Promise.resolve(header) };
  }
  const appId = s.appId ?? '';
  const installationId = s.installationId ?? '';
  let key: KeyObject | undefined;
  let cached: { header: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  const appAuthorization = (): string => {
    key ??= loadKey(s.privateKey ?? '');
    return `Bearer ${appJwt(appId, key, ctx.now())}`;
  };

  async function exchange(): Promise<string> {
    const res = await ctx.http.post(
      `${API_BASE}/app/installations/${installationId}/access_tokens`,
      {
        headers: { ...BASE_HEADERS, authorization: appAuthorization() },
      },
    );
    if (!res.ok) {
      throw new GitHubAuthError(
        `GitHub refused the installation token (${res.status}): ${errorMessage(res)}`,
      );
    }
    const body = obj(res.json());
    const token = str(body?.token);
    const expiresAt = Date.parse(str(body?.expires_at) ?? '');
    if (token === undefined || Number.isNaN(expiresAt)) {
      throw new GitHubAuthError('GitHub returned an installation token response without a token');
    }
    cached = { header: `Bearer ${token}`, expiresAt };
    return cached.header;
  }

  return {
    authorization() {
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > ctx.now().getTime()) {
        return Promise.resolve(cached.header);
      }
      inflight ??= exchange().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}

/** GitHub's `message` from an error body, or the status text. */
export function errorMessage(res: HttpResponse): string {
  try {
    return str(obj(res.json())?.message) ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** A thin REST/GraphQL client over the SDK's `HttpClient`. */
export interface GitHubApi {
  request(method: string, path: string, json?: unknown): Promise<HttpResponse>;
  graphql(query: string, variables: Record<string, unknown>): Promise<HttpResponse>;
}

export function createApi(http: HttpClient, auth: GitHubAuth): GitHubApi {
  async function request(method: string, path: string, json?: unknown): Promise<HttpResponse> {
    const headers = { ...BASE_HEADERS, authorization: await auth.authorization() };
    return http.request({
      method,
      url: `${API_BASE}${path}`,
      headers,
      ...(json !== undefined ? { json } : {}),
    });
  }
  return {
    request,
    graphql: (query, variables) => request('POST', '/graphql', { query, variables }),
  };
}
