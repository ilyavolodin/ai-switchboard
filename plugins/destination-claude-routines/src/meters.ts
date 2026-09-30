import {
  meterReading,
  tryJson,
  tryParse,
  type JSONSchema,
  type MeterReading,
  type PluginContext,
} from '@ai-switchboard/sdk';

import type { RoutinesApi } from './api.js';
import { createSeatTokens, SeatUsageError, secretStoreProblem } from './oauth.js';
import { FIVE_HOUR, SEVEN_DAY, type RoutinesUsageSettings } from './settings.js';

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

/** The usage endpoint's windows as readings; `null` when the body has another shape. */
export function readingsFrom(body: unknown, observedAt: string): MeterReading[] | null {
  const usage = tryParse<UsageResponse>(usageResponseSchema, body);
  if (!usage) return null;
  return ([FIVE_HOUR, SEVEN_DAY] as const).flatMap((id) => {
    const window = usage[id];
    if (!window) return [];
    return [
      meterReading({
        id,
        utilization: window.utilization,
        ...(typeof window.resets_at === 'string' ? { resetsAt: window.resets_at } : {}),
        observedAt,
      }),
    ];
  });
}

export interface SeatMeters {
  read(): Promise<MeterReading[]>;
  /** Why seat usage cannot be read at all, or undefined. */
  problem(): Promise<string | undefined>;
}

export function createSeatMeters(
  usage: RoutinesUsageSettings,
  api: RoutinesApi,
  ctx: PluginContext,
): SeatMeters {
  const tokens = createSeatTokens(usage, ctx);
  let inflight: Promise<MeterReading[]> | undefined;

  async function read(): Promise<MeterReading[]> {
    const seedToken = usage.oauthRefreshToken;
    if (seedToken === undefined) return [];
    // Without somewhere to keep the rotated token, a refresh would spend the only live one.
    const problem = secretStoreProblem(await ctx.secrets.check());
    if (problem !== undefined) throw new SeatUsageError(problem);
    let state = await tokens.fresh(await tokens.load(seedToken), false);
    let res = await api.usage(usage.usageUrl, state.accessToken ?? '');
    if (res.status === 401) {
      // The cached access token was revoked early; refresh once and retry.
      state = await tokens.fresh(state, true);
      res = await api.usage(usage.usageUrl, state.accessToken ?? '');
    }
    if (!res.ok) throw new SeatUsageError(`usage endpoint answered ${res.status}`);
    const readings = readingsFrom(tryJson(res), ctx.now().toISOString());
    if (!readings) throw new SeatUsageError('usage endpoint returned an unexpected shape');
    return readings;
  }

  return {
    problem: async () =>
      usage.oauthRefreshToken === undefined
        ? undefined
        : secretStoreProblem(await ctx.secrets.check()),
    read: () => {
      // Two overlapping reads would both spend the same rotating refresh token.
      inflight ??= read().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
