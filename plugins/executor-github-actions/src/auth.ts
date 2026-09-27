import { sign } from 'node:crypto';

import type { PluginContext } from '@ai-switchboard/sdk';

import { GITHUB_API, type GithubActionsSettings } from './settings.js';

/** Installation tokens live an hour; refresh this long before they expire. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const FRESH_MS = 30_000;

/** The credentials could not be turned into a token. `status` is the GitHub status, if any. */
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
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}

/** A GitHub App JWT (RS256), valid ten minutes with a minute of clock-skew backdating. */
export function appJwt(appId: string | number, privateKey: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const iss = typeof appId === 'string' && /^\d+$/.test(appId) ? Number(appId) : appId;
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat, exp: iat + 600, iss })}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), normalizePem(privateKey));
  return `${data}.${signature.toString('base64url')}`;
}

export interface GithubAuth {
  token(): Promise<string>;
  /** Drop a cached installation token (after a 401). */
  invalidate(): void;
}

/** Token auth, or an App installation token cached in memory until shortly before expiry. */
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
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = undefined;
    }
    const token = (body as { token?: unknown } | undefined)?.token;
    const expiresAt = (body as { expires_at?: unknown } | undefined)?.expires_at;
    if (typeof token !== 'string' || token === '') {
      throw new GithubAuthError('GitHub returned no installation token');
    }
    const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    const now = ctx.now().getTime();
    cached = { token, expiresAt: Number.isNaN(expiry) ? now + 30 * 60_000 : expiry, mintedAt: now };
    return token;
  }

  return {
    token: () => {
      const now = ctx.now().getTime();
      // A token minted a moment ago is used even when GitHub gave it a short life.
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
