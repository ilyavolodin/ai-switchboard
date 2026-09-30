import { createHash } from 'node:crypto';

import {
  tryJson,
  tryParse,
  type JSONSchema,
  type PluginContext,
  type SecretStoreStatus,
} from '@ai-switchboard/sdk';

import type { RoutinesUsageSettings } from './settings.js';

export const OAUTH_STATE_KEY = 'oauth';
/** `ctx.secrets` keys: rotated credentials never go to the instance state. */
export const OAUTH_REFRESH_KEY = 'oauth-refresh-token';
export const OAUTH_ACCESS_KEY = 'oauth-access-token';
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_EXPIRES_IN_SECONDS = 300;

/** Thrown when the seat's OAuth or usage endpoint refuses; the core shows the meter as stale. */
export class SeatUsageError extends Error {
  override readonly name = 'SeatUsageError';
}

/** What the instance state holds: no token, only where the chain started and when it expires. */
export interface OAuthMeta {
  /**
   * Fingerprint of the settings token this chain of rotations started from. When a person pastes
   * a new token into the settings, the fingerprint no longer matches and the chain restarts.
   */
  seed: string;
  expiresAt?: string;
}

export interface OAuthState extends OAuthMeta {
  /** The token endpoint rotates it on every refresh. */
  refreshToken: string;
  accessToken?: string;
}

/**
 * Before SDK 2.2 the tokens sat in the state next to the metadata. Remove this migration (and
 * `LegacyOAuthState`) after 2027-03-31.
 */
interface LegacyOAuthState extends OAuthMeta {
  refreshToken?: unknown;
  accessToken?: unknown;
}

const metaSchema: JSONSchema = {
  type: 'object',
  required: ['seed'],
  properties: { seed: { type: 'string' }, expiresAt: { type: 'string' } },
};

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const tokenResponseSchema: JSONSchema = {
  type: 'object',
  required: ['access_token'],
  properties: {
    access_token: { type: 'string', minLength: 1 },
    refresh_token: { type: 'string', minLength: 1 },
    expires_in: { type: 'number', exclusiveMinimum: 0 },
  },
};

export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function secretStoreProblem(status: SecretStoreStatus): string | undefined {
  return status.writable
    ? undefined
    : `rotated OAuth tokens need a writable secret provider: ${status.reason}`;
}

export interface SeatTokens {
  /** The rotation chain for the settings' refresh token, moving legacy state first. */
  load(seedToken: string): Promise<OAuthState>;
  /** `state` with a live access token, refreshing (and storing the rotation) when needed. */
  fresh(state: OAuthState, force: boolean): Promise<OAuthState>;
}

export function createSeatTokens(usage: RoutinesUsageSettings, ctx: PluginContext): SeatTokens {
  async function load(seedToken: string): Promise<OAuthState> {
    const seed = fingerprint(seedToken);
    const stored = tryParse<LegacyOAuthState>(metaSchema, await ctx.state.get(OAUTH_STATE_KEY));
    if (stored?.seed !== seed) return { refreshToken: seedToken, seed };
    const expiry = stored.expiresAt !== undefined ? { expiresAt: stored.expiresAt } : {};
    if (typeof stored.refreshToken === 'string') {
      // Move what an older version kept in Postgres; the rotated token is the only live one.
      await ctx.secrets.set(OAUTH_REFRESH_KEY, stored.refreshToken);
      const legacyAccess = typeof stored.accessToken === 'string' ? stored.accessToken : undefined;
      if (legacyAccess !== undefined) await ctx.secrets.set(OAUTH_ACCESS_KEY, legacyAccess);
      else await ctx.secrets.delete(OAUTH_ACCESS_KEY);
      await ctx.state.set(OAUTH_STATE_KEY, { seed, ...expiry } satisfies OAuthMeta);
      return {
        refreshToken: stored.refreshToken,
        seed,
        ...(legacyAccess !== undefined ? { accessToken: legacyAccess, ...expiry } : {}),
      };
    }
    // Prefer the stored, rotated token: the one in the settings has been used up.
    const refreshToken = (await ctx.secrets.get(OAUTH_REFRESH_KEY)) ?? seedToken;
    const access = await ctx.secrets.get(OAUTH_ACCESS_KEY);
    return {
      refreshToken,
      seed,
      ...(access !== undefined ? { accessToken: access, ...expiry } : {}),
    };
  }

  async function fresh(state: OAuthState, force: boolean): Promise<OAuthState> {
    const now = ctx.now().getTime();
    if (
      !force &&
      state.accessToken !== undefined &&
      state.expiresAt !== undefined &&
      Date.parse(state.expiresAt) - EXPIRY_MARGIN_MS > now
    ) {
      return state;
    }
    const res = await ctx.http.post(usage.oauthTokenUrl, {
      headers: { accept: 'application/json' },
      json: {
        grant_type: 'refresh_token',
        refresh_token: state.refreshToken,
        client_id: usage.oauthClientId,
      },
    });
    if (!res.ok) {
      throw new SeatUsageError(
        res.status === 400 || res.status === 401
          ? `OAuth refresh token was rejected (${res.status}); paste a fresh refresh token into the instance settings`
          : `OAuth token endpoint answered ${res.status}`,
      );
    }
    const token = tryParse<TokenResponse>(tokenResponseSchema, tryJson(res));
    if (!token) throw new SeatUsageError('OAuth token endpoint returned no access_token');
    const next: OAuthState = {
      refreshToken: token.refresh_token ?? state.refreshToken,
      seed: state.seed,
      accessToken: token.access_token,
      expiresAt: new Date(
        now + (token.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
      ).toISOString(),
    };
    // Store before using it: once rotated, the previous refresh token is dead.
    await ctx.secrets.set(OAUTH_REFRESH_KEY, next.refreshToken);
    await ctx.secrets.set(OAUTH_ACCESS_KEY, token.access_token);
    await ctx.state.set(OAUTH_STATE_KEY, {
      seed: next.seed,
      expiresAt: next.expiresAt,
    } satisfies OAuthMeta);
    return next;
  }

  return { load, fresh };
}
