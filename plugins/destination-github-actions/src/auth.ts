import { sign } from 'node:crypto';

import { asObject, asString, tryJson, type PluginContext } from '@ai-switchboard/sdk';

import { GITHUB_API, type GithubActionsSettings } from './settings.js';

/** Installation tokens live an hour; refresh this long before they expire. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** A token minted this recently is used even when GitHub gave it a shorter life than the margin. */
const FRESH_MS = 30_000;
const FALLBACK_LIFETIME_MS = 30 * 60_000;
/** GitHub accepts App JWTs of at most 10 minutes; backdate `iat` a minute for clock drift. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 600;

export class GithubAuthError extends Error {
  override readonly name = 'GithubAuthError';
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.status = status;
  }
}

export const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'ai-switchboard',
} as const;

/** Keys pasted into a single-line field often carry literal `\n`. */
function normalizePem(key: string): string {
  return (key.includes('\\n') ? key.replace(/\\n/g, '\n') : key).trim();
}

/** A numeric App ID goes in `iss` as a number; a Client ID as the string it is. */
export function jwtIssuer(appId: string | number): string | number {
  return typeof appId === 'string' && /^\d+$/.test(appId) ? Number(appId) : appId;
}

/** A GitHub App JWT (RS256). */
export function appJwt(appId: string | number, privateKey: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - JWT_BACKDATE_S;
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iat, exp: iat + JWT_LIFETIME_S, iss: jwtIssuer(appId) };
  const data = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), normalizePem(privateKey));
  return `${data}.${signature.toString('base64url')}`;
}

export interface GithubAuth {
  token(): Promise<string>;
  /** Drop a cached installation token (after a 401). */
  invalidate(): void;
}

/** App installation tokens are cached in memory (never in `ctx.state`). */
export function createAuth(settings: GithubActionsSettings, ctx: PluginContext): GithubAuth {
  if (settings.auth === 'token') {
    const token = settings.token ?? '';
    return { token: () => Promise.resolve(token), invalidate: () => undefined };
  }
  let cached: { token: string; expiresAt: number; mintedAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function mint(): Promise<string> {
    const { appId, privateKey, installationId } = settings;
    if (appId === undefined || privateKey === undefined || installationId === undefined) {
      throw new GithubAuthError('GitHub App settings are incomplete');
    }
    let jwt: string;
    try {
      jwt = appJwt(appId, privateKey, ctx.now());
    } catch (cause) {
      throw new GithubAuthError('Cannot sign a JWT with the configured private key', undefined, {
        cause,
      });
    }
    const res = await ctx.http.post(
      `${GITHUB_API}/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
      { headers: { ...GITHUB_HEADERS, authorization: `Bearer ${jwt}` } },
    );
    if (!res.ok) {
      throw new GithubAuthError(`GitHub refused an installation token (${res.status})`, res.status);
    }
    const body = asObject(tryJson(res));
    const token = asString(body?.token);
    if (token === undefined || token === '') {
      throw new GithubAuthError('GitHub returned no installation token');
    }
    const expiry = Date.parse(asString(body?.expires_at) ?? '');
    const now = ctx.now().getTime();
    cached = {
      token,
      expiresAt: Number.isNaN(expiry) ? now + FALLBACK_LIFETIME_MS : expiry,
      mintedAt: now,
    };
    return token;
  }

  return {
    token: () => {
      const now = ctx.now().getTime();
      if (
        cached &&
        (cached.expiresAt - TOKEN_MARGIN_MS > now || now - cached.mintedAt < FRESH_MS) &&
        cached.expiresAt > now
      ) {
        return Promise.resolve(cached.token);
      }
      inflight ??= mint().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate: () => {
      cached = undefined;
    },
  };
}
