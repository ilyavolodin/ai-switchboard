import { createHash } from 'node:crypto';

import {
  tryParse,
  type JSONSchema,
  type MeterReading,
  type PluginContext,
} from '@ai-switchboard/sdk';

import { FIVE_HOUR, SEVEN_DAY, type RoutinesUsageSettings } from './settings.js';

export const OAUTH_BETA = 'oauth-2025-04-20';
export const OAUTH_STATE_KEY = 'oauth';
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_EXPIRES_IN_SECONDS = 300;

export interface OAuthState {
  /** The token endpoint rotates it on every refresh. */
  refreshToken: string;
  /**
   * Fingerprint of the settings token this chain of rotations started from. When a person pastes
   * a new token into the settings, the fingerprint no longer matches and the chain restarts.
   */
  seed: string;
  accessToken?: string;
  expiresAt?: string;
}

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

interface UsageWindow {
  utilization: number;
  resets_at?: string | null;
}

type UsageResponse = Partial<Record<typeof FIVE_HOUR | typeof SEVEN_DAY, UsageWindow | null>>;

const windowSchema: JSONSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      required: ['utilization'],
      properties: {
        utilization: { type: 'number' },
        resets_at: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
      },
    },
  ],
};

const usageResponseSchema: JSONSchema = {
  type: 'object',
  properties: { [FIVE_HOUR]: windowSchema, [SEVEN_DAY]: windowSchema },
};

export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Thrown when the seat's OAuth or usage endpoint refuses; the core shows the meter as stale. */
export class SeatUsageError extends Error {
  override readonly name = 'SeatUsageError';
}

export function createSeatMeters(
  usage: RoutinesUsageSettings,
  ctx: PluginContext,
): { read(): Promise<MeterReading[]> } {
  let inflight: Promise<MeterReading[]> | undefined;

  async function loadState(seedToken: string): Promise<OAuthState> {
    const seed = fingerprint(seedToken);
    const stored = await ctx.state.get<OAuthState>(OAUTH_STATE_KEY);
    // Prefer the stored, rotated token: the one in the settings has been used up.
    if (stored?.seed === seed && typeof stored.refreshToken === 'string') return stored;
    return { refreshToken: seedToken, seed };
  }

  async function accessToken(state: OAuthState, force: boolean): Promise<OAuthState> {
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
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = undefined;
    }
    const token = tryParse<TokenResponse>(tokenResponseSchema, body);
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
    await ctx.state.set(OAUTH_STATE_KEY, next);
    return next;
  }

  async function fetchUsage(token: string): Promise<{ status: number; body: unknown }> {
    const res = await ctx.http.get(usage.usageUrl, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
      },
    });
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  }

  async function read(): Promise<MeterReading[]> {
    const seedToken = usage.oauthRefreshToken;
    if (seedToken === undefined) return [];
    let state = await accessToken(await loadState(seedToken), false);
    let res = await fetchUsage(state.accessToken ?? '');
    if (res.status === 401) {
      // The cached access token was revoked early; refresh once and retry.
      state = await accessToken(state, true);
      res = await fetchUsage(state.accessToken ?? '');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new SeatUsageError(`usage endpoint answered ${res.status}`);
    }
    const body = tryParse<UsageResponse>(usageResponseSchema, res.body);
    if (!body) throw new SeatUsageError('usage endpoint returned an unexpected shape');
    const observedAt = ctx.now().toISOString();
    const readings: MeterReading[] = [];
    for (const id of [FIVE_HOUR, SEVEN_DAY] as const) {
      const window = body[id];
      if (!window) continue;
      readings.push({
        id,
        utilization: Math.min(100, Math.max(0, window.utilization)),
        ...(typeof window.resets_at === 'string' ? { resetsAt: window.resets_at } : {}),
        observedAt,
      });
    }
    return readings;
  }

  return {
    read: () => {
      // Two overlapping reads would both spend the same rotating refresh token.
      inflight ??= read().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
