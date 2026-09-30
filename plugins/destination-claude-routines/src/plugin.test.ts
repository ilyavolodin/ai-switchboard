import { describe, expect, it } from 'vitest';

import {
  isInvokeError,
  isTransportError,
  signHmac,
  type Destination,
  type RawRequest,
  type Settings,
} from '@ai-switchboard/sdk';
import {
  createMemorySecrets,
  createMemoryState,
  createStubHttp,
  createTestContext,
  pluginConformanceChecks,
  rawRequest,
  runConformance,
  runHandle,
  type StubHandler,
  type StubRequest,
} from '@ai-switchboard/sdk/testing';

import {
  authError,
  fireResponse,
  fireResponsePrefixed,
  pausedError,
  rateLimitError,
  tokenResponse,
  usageResponse,
} from './__fixtures__/api.js';
import {
  OAUTH_ACCESS_KEY,
  OAUTH_REFRESH_KEY,
  OAUTH_STATE_KEY,
  fingerprint,
  type OAuthMeta,
} from './oauth.js';
import plugin, { routinesDestinationType } from './plugin.js';
import { DEFAULT_BETA_HEADER } from './settings.js';

const TOKEN = 'fixture-secret-trigger-token';
const CALLBACK_SECRET = 'fixture-secret-callback-0001';
const REFRESH = 'fixture-refresh-0';
const NOW = Date.parse('2026-09-27T10:00:00.000Z');

const settings: Settings = {
  token: TOKEN,
  callbackSecret: CALLBACK_SECRET,
  usage: { oauthRefreshToken: REFRESH },
};

function anthropic(
  overrides: Partial<Record<'fire' | 'token' | 'usage', StubHandler>> = {},
): StubHandler {
  let issued = 0;
  return (req) => {
    const path = req.url.pathname;
    if (path.startsWith('/v1/claude_code/routines/')) {
      return overrides.fire ? overrides.fire(req) : { json: fireResponse };
    }
    if (req.url.host === 'console.anthropic.com' && path === '/v1/oauth/token') {
      if (overrides.token) return overrides.token(req);
      issued += 1;
      return { json: tokenResponse(issued) };
    }
    if (path === '/api/oauth/usage') {
      return overrides.usage ? overrides.usage(req) : { json: usageResponse };
    }
    return undefined;
  };
}

function setup(
  handler: StubHandler = anthropic(),
  overrides: Settings = {},
  state = createMemoryState(),
  secrets = createMemorySecrets(),
): {
  destination: Destination;
  calls: StubRequest[];
  state: typeof state;
  secrets: typeof secrets;
} {
  const stub = createStubHttp(handler);
  const ctx = createTestContext({ http: stub.client, now: () => new Date(NOW), state, secrets });
  return {
    destination: routinesDestinationType.create({ ...settings, ...overrides }, ctx),
    calls: stub.calls,
    state,
    secrets,
  };
}

/** No token, rotated or seeded, may reach the instance state (Postgres). */
function expectNoTokens(state: { data: Record<string, unknown> }): void {
  expect(JSON.stringify(state.data)).not.toMatch(/fixture-(refresh|access)/);
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

function signed(body: unknown, secret = CALLBACK_SECRET): RawRequest {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return rawRequest({
    headers: { 'x-switchboard-signature': `sha256=${signHmac({ secret, payload: text })}` },
    body: text,
  });
}

const target = { routineId: 'trig_01ABCDEF' };
const input = { text: 'repository: acme/api\nissue: 42' };

runConformance(
  'claude-routines destination',
  pluginConformanceChecks(plugin, {
    destinations: {
      [routinesDestinationType.id]: {
        settings,
        http: anthropic(),
        unsignedCallback: rawRequest({ body: { runId: 'r1', status: 'ok' } }),
        now: () => new Date(NOW),
      },
    },
  }),
  { describe, it },
);

describe('claude-routines: invoke timeout', () => {
  it('allows the one fire request (30 s HTTP timeout) to answer', () => {
    expect(routinesDestinationType.invokeTimeoutSeconds).toBe(60);
  });
});

describe('claude-routines: invoke', () => {
  it('fires the routine with the trigger token, version and beta headers', async () => {
    const { destination, calls } = setup();
    const result = await destination.invoke(target, input, runHandle({ id: 'run-1' }));
    expect(result).toEqual({
      status: 'started',
      externalId: fireResponse.id,
      externalUrl: fireResponse.session_url,
    });
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url.toString()).toBe(
      'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEF/fire',
    );
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers['anthropic-version']).toBe('2023-06-01');
    expect(call?.headers['anthropic-beta']).toBe(DEFAULT_BETA_HEADER);
  });

  it('appends a delimited trailer with the run id and callback url', async () => {
    const { destination, calls } = setup();
    await destination.invoke(
      target,
      input,
      runHandle({ id: 'run-42', callbackUrl: 'https://sb.test/callbacks/i1' }),
    );
    const text = calls[0]?.json<{ text: string }>().text;
    expect(text).toBe(
      'repository: acme/api\nissue: 42\n\n' +
        '--- switchboard ---\n' +
        'switchboard_run_id: run-42\n' +
        'switchboard_callback_url: https://sb.test/callbacks/i1\n' +
        '--- end switchboard ---\n',
    );
  });

  it('marks dry runs in the trailer', async () => {
    const { destination, calls } = setup();
    await destination.invoke(target, input, runHandle({ dryRun: true }));
    expect(calls[0]?.json<{ text: string }>().text).toContain('switchboard_dry_run: true');
  });

  it('uses a configured beta header and base url', async () => {
    const { destination, calls } = setup(anthropic(), {
      betaHeader: 'routines-2027-01-01',
      apiBaseUrl: 'https://api.anthropic.com/',
    });
    await destination.invoke(target, input, runHandle());
    expect(calls[0]?.headers['anthropic-beta']).toBe('routines-2027-01-01');
    expect(calls[0]?.url.pathname).toBe('/v1/claude_code/routines/trig_01ABCDEF/fire');
  });

  it('tolerates response shape variations', async () => {
    const prefixed = setup(anthropic({ fire: () => ({ json: fireResponsePrefixed }) }));
    expect(await prefixed.destination.invoke(target, input, runHandle())).toEqual({
      status: 'started',
      externalId: 'session_01Prefixed',
      externalUrl: 'https://claude.ai/code/session_01Prefixed',
    });
    const nested = setup(
      anthropic({
        fire: () => ({ json: { session: { id: 's-9', url: 'https://claude.ai/code/s-9' } } }),
      }),
    );
    expect(await nested.destination.invoke(target, input, runHandle())).toMatchObject({
      externalId: 's-9',
      externalUrl: 'https://claude.ai/code/s-9',
    });
    const empty = setup(anthropic({ fire: () => ({ status: 202, body: 'accepted' }) }));
    expect(await empty.destination.invoke(target, input, runHandle())).toEqual({
      status: 'started',
    });
  });

  it('429 returns failed with retryAfterSeconds', async () => {
    const { destination } = setup(
      anthropic({
        fire: () => ({ status: 429, headers: { 'retry-after': '900' }, json: rateLimitError }),
      }),
    );
    const result = await destination.invoke(target, input, runHandle());
    expect(result.status).toBe('failed');
    expect(result.retryAfterSeconds).toBe(900);
    expect(result.errors?.[0]).toContain('Daily routine run limit reached');
  });

  it('429 without retry-after defaults to 60 seconds', async () => {
    const { destination } = setup(
      anthropic({ fire: () => ({ status: 429, json: rateLimitError }) }),
    );
    expect((await destination.invoke(target, input, runHandle())).retryAfterSeconds).toBe(60);
  });

  it('400 "paused" is held: paused', async () => {
    const { destination } = setup(anthropic({ fire: () => ({ status: 400, json: pausedError }) }));
    expect(await destination.invoke(target, input, runHandle())).toEqual({
      status: 'held',
      reason: 'paused',
    });
  });

  it('400 "disabled" is held: disabled', async () => {
    const { destination } = setup(
      anthropic({
        fire: () => ({
          status: 400,
          json: {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Routine is disabled' },
          },
        }),
      }),
    );
    expect(await destination.invoke(target, input, runHandle())).toEqual({
      status: 'held',
      reason: 'disabled',
    });
  });

  it.each([
    [400, true, 400],
    [401, true, 401],
    [403, true, 403],
    [404, true, 404],
    [503, false, 503],
    [529, false, 503],
    [500, false, 500],
  ])('%i maps to InvokeError definitive=%s', async (status, definitive, expected) => {
    const { destination } = setup(anthropic({ fire: () => ({ status, json: authError }) }));
    const err = await thrown(destination.invoke(target, input, runHandle()));
    expect(isInvokeError(err)).toBe(true);
    if (!isInvokeError(err)) return;
    expect(err.definitive).toBe(definitive);
    expect(err.status).toBe(expected);
  });

  it('lets TransportError through', async () => {
    const { destination } = setup(() => {
      throw Object.assign(new Error('timeout'), { code: 'UND_ERR_SOCKET' });
    });
    const err = await thrown(destination.invoke(target, input, runHandle()));
    expect(isTransportError(err) && err.sent).toBe(true);
  });

  it('rejects an invalid target or input before sending anything', async () => {
    const { destination, calls } = setup();
    const badTarget = await thrown(destination.invoke({ routineId: '../x' }, input, runHandle()));
    expect(isInvokeError(badTarget) && badTarget.definitive).toBe(true);
    const badInput = await thrown(destination.invoke(target, { text: '' }, runHandle()));
    expect(isInvokeError(badInput) && badInput.definitive).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('claude-routines: verifyCallback', () => {
  const { destination } = setup();
  const verify = (req: RawRequest): ReturnType<NonNullable<Destination['verifyCallback']>> =>
    destination.verifyCallback?.(req) ?? null;

  const body = {
    runId: 'run-1',
    status: 'ok',
    sessionUrl: 'https://claude.ai/code/session_01FixtureSession',
    usage: {
      input_tokens: 1200,
      output_tokens: 800,
      cache_read_tokens: 50_000,
      cache_write_tokens: 4000,
      duration_seconds: 312,
    },
    finishedAt: '2026-09-27T10:06:00Z',
  };

  it('accepts a signed callback and maps usage and the session url', () => {
    expect(verify(signed(body))).toEqual({
      runId: 'run-1',
      status: {
        state: 'ok',
        usage: body.usage,
        finishedAt: '2026-09-27T10:06:00Z',
        externalUrl: body.sessionUrl,
      },
    });
  });

  it('maps an error callback', () => {
    const result = verify(signed({ runId: 'run-1', status: 'error', errors: ['tests failed'] }));
    expect(result?.status).toEqual({ state: 'error', errors: ['tests failed'] });
  });

  it('rejects a wrong or missing signature', () => {
    expect(verify(signed(body, 'fixture-secret-wrong-0000'))).toBeNull();
    expect(verify(rawRequest({ body }))).toBeNull();
    expect(
      verify(rawRequest({ headers: { 'x-switchboard-signature': 'sha256=' }, body })),
    ).toBeNull();
  });

  it('rejects malformed bodies', () => {
    expect(verify(signed('not json'))).toBeNull();
    expect(verify(signed({ runId: 'run-1', status: 'finished' }))).toBeNull();
    expect(verify(signed({ runId: '', status: 'ok' }))).toBeNull();
    expect(
      verify(signed({ runId: 'run-1', status: 'ok', usage: { input_tokens: -1 } })),
    ).toBeNull();
    expect(
      verify(signed({ runId: 'run-1', status: 'ok', sessionUrl: 'javascript:alert(1)' })),
    ).toBeNull();
  });

  it('ignores unknown fields and undeclared usage keys', () => {
    const result = verify(
      signed({
        runId: 'run-1',
        status: 'ok',
        model: 'x',
        usage: { input_tokens: 5, web_searches: 2 },
      }),
    );
    expect(result).toEqual({ runId: 'run-1', status: { state: 'ok', usage: { input_tokens: 5 } } });
  });
});

describe('claude-routines: meters', () => {
  it('declares five_hour (primary), seven_day and an estimated daily_runs', () => {
    const meters = routinesDestinationType.metersFor?.({
      ...settings,
      usage: { dailyRunLimit: 25 },
    });
    expect(meters?.map((m) => [m.id, m.kind, m.primary === true])).toEqual([
      ['five_hour', 'window', true],
      ['seven_day', 'window', false],
      ['daily_runs', 'allowance', false],
    ]);
    expect(meters?.[2]?.estimate).toEqual({ period: 'day', defaultLimit: 25 });
    expect(routinesDestinationType.meters?.[2]?.estimate).toEqual({
      period: 'day',
      defaultLimit: 15,
    });
  });

  it('refreshes the access token and reads both windows', async () => {
    const { destination, calls } = setup();
    const readings = await destination.readMeters?.();
    expect(readings).toEqual([
      {
        id: 'five_hour',
        utilization: 37,
        resetsAt: '2026-09-27T13:00:00.000Z',
        observedAt: new Date(NOW).toISOString(),
      },
      {
        id: 'seven_day',
        utilization: 61.5,
        resetsAt: '2026-10-01T08:00:00.000Z',
        observedAt: new Date(NOW).toISOString(),
      },
    ]);
    const tokenCall = calls[0];
    expect(tokenCall?.url.toString()).toBe('https://console.anthropic.com/v1/oauth/token');
    expect(tokenCall?.json()).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    });
    const usageCall = calls[1];
    expect(usageCall?.url.toString()).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(usageCall?.headers.authorization).toBe('Bearer fixture-access-1');
    expect(usageCall?.headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('stores the rotated tokens in ctx.secrets and only their metadata in state', async () => {
    const { destination, state, secrets } = setup();
    await destination.readMeters?.();
    expect(secrets.data).toEqual({
      [OAUTH_REFRESH_KEY]: 'fixture-refresh-1',
      [OAUTH_ACCESS_KEY]: 'fixture-access-1',
    });
    expect(state.data[OAUTH_STATE_KEY]).toEqual({
      seed: fingerprint(REFRESH),
      expiresAt: new Date(NOW + 28_800_000).toISOString(),
    });
    expectNoTokens(state);
  });

  it('reuses a valid cached access token without refreshing', async () => {
    const { destination, calls } = setup();
    await destination.readMeters?.();
    await destination.readMeters?.();
    expect(calls.filter((c) => c.url.pathname === '/v1/oauth/token')).toHaveLength(1);
    expect(calls.filter((c) => c.url.pathname === '/api/oauth/usage')).toHaveLength(2);
  });

  it('prefers the stored rotated refresh token over the settings on a later instance', async () => {
    const state = createMemoryState({
      [OAUTH_STATE_KEY]: {
        seed: fingerprint(REFRESH),
        expiresAt: new Date(NOW - 1000).toISOString(),
      } satisfies OAuthMeta,
    });
    const secrets = createMemorySecrets({
      [OAUTH_REFRESH_KEY]: 'fixture-refresh-rotated',
      [OAUTH_ACCESS_KEY]: 'expired',
    });
    const { destination, calls } = setup(anthropic(), {}, state, secrets);
    await destination.readMeters?.();
    expect(calls[0]?.json<{ refresh_token: string }>().refresh_token).toBe(
      'fixture-refresh-rotated',
    );
  });

  it('restarts the chain when a person pastes a new refresh token into the settings', async () => {
    const state = createMemoryState({
      [OAUTH_STATE_KEY]: { seed: fingerprint(REFRESH) } satisfies OAuthMeta,
    });
    const secrets = createMemorySecrets({ [OAUTH_REFRESH_KEY]: 'fixture-refresh-rotated' });
    const { destination, calls } = setup(
      anthropic(),
      { usage: { oauthRefreshToken: 'fixture-refresh-pasted' } },
      state,
      secrets,
    );
    await destination.readMeters?.();
    expect(calls[0]?.json<{ refresh_token: string }>().refresh_token).toBe(
      'fixture-refresh-pasted',
    );
    expect((state.data[OAUTH_STATE_KEY] as OAuthMeta).seed).toBe(
      fingerprint('fixture-refresh-pasted'),
    );
    expect(secrets.data[OAUTH_REFRESH_KEY]).toBe('fixture-refresh-1');
  });

  it('keeps the old refresh token when the token endpoint does not rotate it', async () => {
    const { destination, state, secrets } = setup(
      anthropic({
        token: () => ({ json: { access_token: 'fixture-access-x', expires_in: 3600 } }),
      }),
    );
    await destination.readMeters?.();
    expect(secrets.data[OAUTH_REFRESH_KEY]).toBe(REFRESH);
    expectNoTokens(state);
  });

  it('moves tokens an older version kept in state into ctx.secrets', async () => {
    const state = createMemoryState({
      [OAUTH_STATE_KEY]: {
        refreshToken: 'fixture-refresh-legacy',
        seed: fingerprint(REFRESH),
        accessToken: 'fixture-access-legacy',
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
      },
    });
    const { destination, calls, secrets } = setup(anthropic(), {}, state);
    expect(await destination.readMeters?.()).toHaveLength(2);
    expect(calls.filter((c) => c.url.pathname === '/v1/oauth/token')).toHaveLength(0);
    expect(calls[0]?.headers.authorization).toBe('Bearer fixture-access-legacy');
    expect(secrets.data).toEqual({
      [OAUTH_REFRESH_KEY]: 'fixture-refresh-legacy',
      [OAUTH_ACCESS_KEY]: 'fixture-access-legacy',
    });
    expectNoTokens(state);
  });

  it('refuses to rotate without a writable secret provider, and says so in health', async () => {
    const state = createMemoryState();
    const { destination, calls } = setup(
      anthropic(),
      {},
      state,
      createMemorySecrets({}, { writable: false }),
    );
    await expect(destination.readMeters?.()).rejects.toThrow(/writable secret provider/);
    expect(calls).toHaveLength(0);
    expectNoTokens(state);
    const health = await destination.health();
    expect(health.status).toBe('unhealthy');
    expect(health.message).toMatch(/writable secret provider/);
  });

  it('leaves legacy tokens in place (not lost) when they cannot be moved yet', async () => {
    const legacy = { refreshToken: 'fixture-refresh-legacy', seed: fingerprint(REFRESH) };
    const state = createMemoryState({ [OAUTH_STATE_KEY]: legacy });
    const { destination } = setup(
      anthropic(),
      {},
      state,
      createMemorySecrets({}, { writable: false }),
    );
    await expect(destination.readMeters?.()).rejects.toThrow(/writable secret provider/);
    expect(state.data[OAUTH_STATE_KEY]).toEqual(legacy);
  });

  it('refreshes once and retries when the usage endpoint rejects the access token', async () => {
    let usageCalls = 0;
    const { destination, calls } = setup(
      anthropic({
        usage: () => {
          usageCalls += 1;
          return usageCalls === 1 ? { status: 401 } : { json: usageResponse };
        },
      }),
    );
    expect(await destination.readMeters?.()).toHaveLength(2);
    expect(calls.filter((c) => c.url.pathname === '/v1/oauth/token')).toHaveLength(2);
  });

  it('serialises overlapping reads so the rotating token is spent once', async () => {
    const { destination, calls } = setup();
    await Promise.all([destination.readMeters?.(), destination.readMeters?.()]);
    expect(calls.filter((c) => c.url.pathname === '/v1/oauth/token')).toHaveLength(1);
  });

  it('returns no readings when no refresh token is configured', async () => {
    const { destination, calls } = setup(anthropic(), { usage: {} });
    expect(await destination.readMeters?.()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('skips windows the endpoint reports as null and clamps utilization', async () => {
    const { destination } = setup(
      anthropic({
        usage: () => ({
          json: { five_hour: { utilization: 140, resets_at: null }, seven_day: null },
        }),
      }),
    );
    expect(await destination.readMeters?.()).toEqual([
      { id: 'five_hour', utilization: 100, observedAt: new Date(NOW).toISOString() },
    ]);
  });

  it('throws a clear error when the refresh token is rejected or the endpoint changes', async () => {
    const rejected = setup(
      anthropic({ token: () => ({ status: 400, json: { error: 'invalid_grant' } }) }),
    );
    await expect(rejected.destination.readMeters?.()).rejects.toThrow(/refresh token was rejected/);
    const changed = setup(anthropic({ usage: () => ({ json: { five_hour: 'soon' } }) }));
    await expect(changed.destination.readMeters?.()).rejects.toThrow(/unexpected shape/);
    const gone = setup(anthropic({ usage: () => ({ status: 404 }) }));
    await expect(gone.destination.readMeters?.()).rejects.toThrow(/404/);
  });
});

describe('claude-routines: settings and health', () => {
  it('requires the trigger token and callback secret', () => {
    expect(() => routinesDestinationType.create({ token: TOKEN }, createTestContext())).toThrow(
      /callbackSecret/,
    );
  });

  it('health is unknown (no read-only check exists)', async () => {
    const { destination } = setup();
    expect((await destination.health()).status).toBe('unknown');
  });

  it('health does not need a writable store without seat usage', async () => {
    const { destination } = setup(
      anthropic(),
      { usage: {} },
      createMemoryState(),
      createMemorySecrets({}, { writable: false }),
    );
    expect((await destination.health()).status).toBe('unknown');
  });

  it('health reports a failing secret store as unhealthy instead of throwing', async () => {
    const secrets = createMemorySecrets();
    secrets.check = () => Promise.reject(new Error('secret provider unreachable'));
    const { destination } = setup(anthropic(), {}, createMemoryState(), secrets);
    await expect(destination.health()).resolves.toMatchObject({
      status: 'unhealthy',
      message: 'secret provider unreachable',
    });
  });
});
