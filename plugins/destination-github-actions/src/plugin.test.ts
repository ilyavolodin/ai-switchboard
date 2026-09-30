import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { isInvokeError, type Destination, type Settings } from '@ai-switchboard/sdk';
import {
  createMemoryState,
  createStubHttp,
  createTestContext,
  pluginConformanceChecks,
  runConformance,
  runHandle,
  type StubHandler,
  type StubReply,
  type StubRequest,
} from '@ai-switchboard/sdk/testing';

import {
  RUN_ID,
  SWITCHBOARD_RUN,
  dispatchDetails,
  installationToken,
  jobs,
  rateLimit,
  runList,
  timing,
  workflowRun,
} from './__fixtures__/github.js';
import { pendingKey, type PendingDispatch } from './correlation.js';
import plugin, { githubActionsDestinationType } from './plugin.js';

const PAT = 'fixture-secret-pat';
const NOW = Date.parse('2026-09-27T10:00:00.000Z');
const tokenSettings: Settings = { auth: 'token', token: PAT };
const target = { owner: 'acme', repo: 'api', workflow: 'triage.yml', ref: 'main' };
const REPO = '/repos/acme/api';
const RUN_PATH = `${REPO}/actions/runs/${RUN_ID}`;

type Routes = Partial<
  Record<'token' | 'dispatch' | 'list' | 'run' | 'timing' | 'jobs' | 'rateLimit', StubHandler>
>;

function github(routes: Routes = {}): StubHandler {
  const reply = (
    key: keyof Routes,
    req: StubRequest,
    fallback: StubReply,
  ): ReturnType<StubHandler> => (routes[key] ? routes[key](req) : fallback);
  return (req) => {
    const path = req.url.pathname;
    if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      return reply('token', req, { status: 201, json: installationToken });
    }
    if (req.method === 'POST' && path === `${REPO}/actions/workflows/triage.yml/dispatches`) {
      return reply('dispatch', req, { status: 204 });
    }
    if (path === `${REPO}/actions/workflows/triage.yml/runs`) {
      return reply('list', req, { json: runList([workflowRun()]) });
    }
    if (path === RUN_PATH) return reply('run', req, { json: workflowRun() });
    if (path === `${RUN_PATH}/timing`) return reply('timing', req, { json: timing });
    if (path === `${RUN_PATH}/jobs`) return reply('jobs', req, { json: jobs });
    if (path === '/rate_limit') return reply('rateLimit', req, { json: rateLimit });
    return undefined;
  };
}

function setup(
  handler: StubHandler = github(),
  settings: Settings = tokenSettings,
  options: { state?: ReturnType<typeof createMemoryState>; now?: () => Date } = {},
): { destination: Destination; calls: StubRequest[]; state: ReturnType<typeof createMemoryState> } {
  const stub = createStubHttp(handler);
  const state = options.state ?? createMemoryState();
  const ctx = createTestContext({
    http: stub.client,
    now: options.now ?? (() => new Date(NOW)),
    state,
  });
  return {
    destination: githubActionsDestinationType.create(settings, ctx),
    calls: stub.calls,
    state,
  };
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

const run = (overrides: Parameters<typeof runHandle>[0] = {}): ReturnType<typeof runHandle> =>
  runHandle({ id: SWITCHBOARD_RUN, ...overrides });

runConformance(
  'github-actions destination',
  pluginConformanceChecks(plugin, {
    destinations: {
      [githubActionsDestinationType.id]: {
        settings: tokenSettings,
        http: github(),
        now: () => new Date(NOW),
      },
    },
  }),
  { describe, it },
);

describe('github-actions: invoke timeout', () => {
  it('allows a token exchange, the dispatch and a correlation lookup to answer', () => {
    expect(githubActionsDestinationType.invokeTimeoutSeconds).toBe(120);
  });
});

describe('github-actions: invoke', () => {
  it('dispatches with the inputs plus switchboard_run_id', async () => {
    const { destination, calls } = setup(github({ dispatch: () => ({ json: dispatchDetails }) }));
    await destination.invoke(target, { issue: '42' }, run());
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url.toString()).toBe(
      'https://api.github.com/repos/acme/api/actions/workflows/triage.yml/dispatches',
    );
    expect(call?.json()).toEqual({
      ref: 'main',
      inputs: { issue: '42', switchboard_run_id: SWITCHBOARD_RUN },
      return_run_details: true,
    });
    expect(call?.headers.authorization).toBe(`Bearer ${PAT}`);
    expect(call?.headers.accept).toBe('application/vnd.github+json');
    expect(call?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('uses the run details when GitHub returns them', async () => {
    const { destination, calls } = setup(github({ dispatch: () => ({ json: dispatchDetails }) }));
    const result = await destination.invoke(target, {}, run());
    expect(result).toEqual({
      status: 'started',
      externalId: `acme/api/${RUN_ID}`,
      externalUrl: dispatchDetails.html_url,
    });
    expect(calls).toHaveLength(1);
  });

  it('defaults ref to main and accepts a numeric workflow id', async () => {
    const { destination, calls } = setup((req) =>
      req.url.pathname.endsWith('/workflows/161335/dispatches')
        ? { json: dispatchDetails }
        : undefined,
    );
    await destination.invoke({ owner: 'acme', repo: 'api', workflow: 161335 }, {}, run());
    expect(calls[0]?.json<{ ref: string }>().ref).toBe('main');
  });

  it('on 204, correlates the run by the run id in its name', async () => {
    const { destination, calls } = setup(
      github({
        list: () => ({
          json: runList([
            workflowRun({ id: 1, name: 'other', display_title: 'other' }),
            workflowRun(),
          ]),
        }),
      }),
    );
    const result = await destination.invoke(target, {}, run());
    expect(result).toEqual({
      status: 'started',
      externalId: `acme/api/${RUN_ID}`,
      externalUrl: `https://github.com/acme/api/actions/runs/${RUN_ID}`,
    });
    const list = calls[1];
    expect(list?.url.searchParams.get('event')).toBe('workflow_dispatch');
    expect(list?.url.searchParams.get('created')).toBe('>=2026-09-27T09:58:00Z');
  });

  it('keeps paging the run list when the dispatched run is not on the first page', async () => {
    const others = Array.from({ length: 50 }, (_, i) =>
      workflowRun({ id: 1_000 + i, name: `other ${i}`, display_title: `other ${i}` }),
    );
    const { destination, calls } = setup(
      github({
        list: (req) => ({
          json: runList(req.url.searchParams.get('page') === '2' ? [workflowRun()] : others),
        }),
      }),
    );
    const result = await destination.invoke(target, {}, run());
    expect(result).toMatchObject({ status: 'started', externalId: `acme/api/${RUN_ID}` });
    expect(calls.filter((c) => c.url.pathname.endsWith('/runs')).length).toBe(2);
  });

  it('matches on display_title too', async () => {
    const { destination } = setup(
      github({
        list: () => ({
          json: runList([
            workflowRun({ name: 'Triage', display_title: `Triage ${SWITCHBOARD_RUN}` }),
          ]),
        }),
      }),
    );
    expect((await destination.invoke(target, {}, run())).externalId).toBe(`acme/api/${RUN_ID}`);
  });

  it('returns started without an external id and records the dispatch when not listed yet', async () => {
    const { destination, state } = setup(github({ list: () => ({ json: runList([]) }) }));
    const result = await destination.invoke(target, {}, run());
    expect(result).toEqual({ status: 'started' });
    expect(state.data[pendingKey(SWITCHBOARD_RUN)]).toEqual({
      owner: 'acme',
      repo: 'api',
      workflow: 'triage.yml',
      dispatchedAt: new Date(NOW).toISOString(),
    });
  });

  it('never fails a sent dispatch because correlation failed', async () => {
    const down = setup(github({ list: () => ({ status: 500 }) }));
    expect(await down.destination.invoke(target, {}, run())).toEqual({ status: 'started' });
    const broken = setup(
      github({
        list: () => {
          throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        },
      }),
    );
    expect(await broken.destination.invoke(target, {}, run())).toEqual({ status: 'started' });
  });

  it('403 with an exhausted rate limit returns failed with retryAfter until the reset', async () => {
    const reset = NOW / 1000 + 600;
    const { destination } = setup(
      github({
        dispatch: () => ({
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
          json: { message: 'API rate limit exceeded' },
        }),
      }),
    );
    const result = await destination.invoke(target, {}, run());
    expect(result).toMatchObject({ status: 'failed', retryAfterSeconds: 600 });
  });

  it('429 returns failed with retry-after', async () => {
    const { destination } = setup(
      github({
        dispatch: () => ({
          status: 429,
          headers: { 'retry-after': '30' },
          json: { message: 'slow down' },
        }),
      }),
    );
    expect(await destination.invoke(target, {}, run())).toMatchObject({
      status: 'failed',
      retryAfterSeconds: 30,
    });
  });

  it.each([
    [422, true],
    [404, true],
    [401, true],
    [403, true],
    [503, false],
    [500, false],
  ])('dispatch %i maps to InvokeError definitive=%s', async (status, definitive) => {
    const { destination } = setup(
      github({ dispatch: () => ({ status, json: { message: 'Unexpected inputs provided' } }) }),
    );
    const err = await thrown(destination.invoke(target, {}, run()));
    expect(isInvokeError(err)).toBe(true);
    if (!isInvokeError(err)) return;
    expect(err.status).toBe(status);
    expect(err.definitive).toBe(definitive);
    expect(err.message).toContain('Unexpected inputs provided');
  });

  it('rejects non-string inputs and a bad target before calling GitHub', async () => {
    const { destination, calls } = setup();
    const badInput = await thrown(destination.invoke(target, { issue: 42 }, run()));
    expect(isInvokeError(badInput) && badInput.definitive).toBe(true);
    const badTarget = await thrown(destination.invoke({ ...target, owner: 'a/b' }, {}, run()));
    expect(isInvokeError(badTarget) && badTarget.definitive).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('github-actions: poll', () => {
  const externalId = `acme/api/${RUN_ID}`;

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])(
    'status %s is running',
    async (status) => {
      const { destination } = setup(github({ run: () => ({ json: workflowRun({ status }) }) }));
      const result = await destination.poll?.(run({ externalId }));
      expect(result).toEqual({
        state: 'running',
        externalUrl: `https://github.com/acme/api/actions/runs/${RUN_ID}`,
      });
    },
  );

  it('completed success is ok with billable minutes, duration and jobs', async () => {
    const { destination } = setup(
      github({
        run: () => ({ json: workflowRun({ status: 'completed', conclusion: 'success' }) }),
      }),
    );
    const result = await destination.poll?.(run({ externalId }));
    expect(result).toEqual({
      state: 'ok',
      externalUrl: `https://github.com/acme/api/actions/runs/${RUN_ID}`,
      finishedAt: '2026-09-27T10:04:05Z',
      usage: {
        // Ubuntu jobs rounded up one by one: 2 + 1 + 2; macOS from total_ms: 2.
        billable_minutes_ubuntu: 5,
        billable_minutes_macos: 2,
        billable_minutes: 7,
        duration_seconds: 240,
        jobs: 4,
      },
    });
  });

  it.each(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required'])(
    'completed %s is error',
    async (conclusion) => {
      const { destination } = setup(
        github({ run: () => ({ json: workflowRun({ status: 'completed', conclusion }) }) }),
      );
      const result = await destination.poll?.(run({ externalId }));
      expect(result?.state).toBe('error');
      expect(result?.errors).toEqual([`Workflow run concluded ${conclusion}`]);
      expect(result?.usage?.billable_minutes).toBe(7);
    },
  );

  it('falls back to the run timestamps when the timing endpoint is unavailable', async () => {
    const { destination } = setup(
      github({
        run: () => ({ json: workflowRun({ status: 'completed', conclusion: 'success' }) }),
        timing: () => ({ status: 404 }),
      }),
    );
    const result = await destination.poll?.(run({ externalId }));
    expect(result?.usage).toEqual({ duration_seconds: 240, jobs: 4 });
  });

  it('reports zero billable minutes when GitHub bills nothing', async () => {
    const { destination } = setup(
      github({
        run: () => ({ json: workflowRun({ status: 'completed', conclusion: 'success' }) }),
        timing: () => ({ json: { billable: {}, run_duration_ms: 1000 } }),
      }),
    );
    expect((await destination.poll?.(run({ externalId })))?.usage).toEqual({
      billable_minutes: 0,
      duration_seconds: 1,
      jobs: 4,
    });
  });

  it('a deleted run is unknown', async () => {
    const { destination } = setup(github({ run: () => ({ status: 404 }) }));
    expect((await destination.poll?.(run({ externalId })))?.state).toBe('unknown');
  });

  it('throws on other API errors so the core polls again', async () => {
    const { destination } = setup(github({ run: () => ({ status: 502 }) }));
    await expect(destination.poll?.(run({ externalId }))).rejects.toThrow(/502/);
  });

  it('correlates a pending dispatch on a later poll and remembers it', async () => {
    let listed = false;
    const { destination, state, calls } = setup(
      github({ list: () => ({ json: runList(listed ? [workflowRun()] : []) }) }),
    );
    expect(await destination.invoke(target, {}, run())).toEqual({ status: 'started' });
    expect(await destination.poll?.(run())).toEqual({ state: 'running' });
    listed = true;
    const status = await destination.poll?.(run());
    expect(status?.state).toBe('running');
    expect(status?.externalUrl).toBe(`https://github.com/acme/api/actions/runs/${RUN_ID}`);
    expect((state.data[pendingKey(SWITCHBOARD_RUN)] as PendingDispatch).runId).toBe(RUN_ID);
    const listsBefore = calls.filter((c) => c.url.pathname.endsWith('/runs')).length;
    await destination.poll?.(run());
    expect(calls.filter((c) => c.url.pathname.endsWith('/runs')).length).toBe(listsBefore);
  });

  it('is unknown when nothing was dispatched for the run', async () => {
    const { destination } = setup();
    expect((await destination.poll?.(run({ id: 'never-dispatched' })))?.state).toBe('unknown');
  });
});

describe('github-actions: meters and health', () => {
  it('reads the core rate limit as the api_rate_limit meter', async () => {
    const { destination } = setup();
    expect(await destination.readMeters?.()).toEqual([
      {
        id: 'api_rate_limit',
        used: 1250,
        limit: 5000,
        utilization: 25,
        resetsAt: new Date(1_790_500_000 * 1000).toISOString(),
        observedAt: new Date(NOW).toISOString(),
      },
    ]);
  });

  it('throws on an unusable rate limit response', async () => {
    const { destination } = setup(github({ rateLimit: () => ({ json: { resources: {} } }) }));
    await expect(destination.readMeters?.()).rejects.toThrow(/rate_limit/);
  });

  it('declares the meter as primary and the usage dimensions with units', () => {
    expect(githubActionsDestinationType.meters).toEqual([
      {
        id: 'api_rate_limit',
        title: 'GitHub API rate limit',
        kind: 'window',
        unit: 'requests',
        primary: true,
      },
    ]);
    expect(githubActionsDestinationType.usage.map((d) => `${d.id}:${d.unit}`)).toEqual([
      'billable_minutes:minutes',
      'billable_minutes_ubuntu:minutes',
      'billable_minutes_macos:minutes',
      'billable_minutes_windows:minutes',
      'duration_seconds:seconds',
      'jobs:count',
    ]);
  });

  it('health reflects the credentials', async () => {
    expect((await setup().destination.health()).status).toBe('healthy');
    const bad = setup(
      github({ rateLimit: () => ({ status: 401, json: { message: 'Bad credentials' } }) }),
    );
    const health = await bad.destination.health();
    expect(health.status).toBe('unhealthy');
    expect(health.message).toContain('Bad credentials');
  });
});

describe('github-actions: GitHub App auth', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const appSettings: Settings = {
    auth: 'app',
    appId: '123456',
    privateKey: pem,
    installationId: 777,
  };

  it('signs an RS256 JWT and exchanges it for an installation token', async () => {
    const { destination, calls } = setup(
      github({ dispatch: () => ({ json: dispatchDetails }) }),
      appSettings,
    );
    await destination.invoke(target, {}, run());
    const tokenCall = calls[0];
    expect(tokenCall?.url.pathname).toBe('/app/installations/777/access_tokens');
    const jwt = tokenCall?.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
    expect(claims).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: 123456 });
    expect(
      verifySignature(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${installationToken.token}`);
  });

  it('caches the installation token until shortly before it expires', async () => {
    let t = NOW;
    const { destination, calls } = setup(
      github({
        dispatch: () => ({ json: dispatchDetails }),
        token: () => ({
          status: 201,
          json: { ...installationToken, expires_at: new Date(t + 3_600_000).toISOString() },
        }),
      }),
      appSettings,
      { now: () => new Date(t) },
    );
    await destination.invoke(target, {}, run());
    await destination.invoke(target, {}, run());
    expect(calls.filter((c) => c.url.pathname.endsWith('/access_tokens'))).toHaveLength(1);
    t += 3_600_000 - 60_000;
    await destination.invoke(target, {}, run());
    expect(calls.filter((c) => c.url.pathname.endsWith('/access_tokens'))).toHaveLength(2);
  });

  it('accepts a PEM pasted with literal \\n sequences', async () => {
    const { destination } = setup(github({ dispatch: () => ({ json: dispatchDetails }) }), {
      ...appSettings,
      privateKey: pem.replace(/\n/g, '\\n'),
    });
    expect((await destination.invoke(target, {}, run())).status).toBe('started');
  });

  it('a refused installation token is definitive and nothing is dispatched', async () => {
    const { destination, calls } = setup(github({ token: () => ({ status: 401 }) }), appSettings);
    const err = await thrown(destination.invoke(target, {}, run()));
    expect(isInvokeError(err) && err.definitive).toBe(true);
    expect(calls.some((c) => c.url.pathname.endsWith('/dispatches'))).toBe(false);
  });

  it('a token endpoint network failure is retryable (nothing was dispatched)', async () => {
    const { destination } = setup(
      github({
        token: () => {
          throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        },
      }),
      appSettings,
    );
    const err = await thrown(destination.invoke(target, {}, run()));
    expect(isInvokeError(err) && err.sent).toBe(false);
  });

  it('an unusable private key is definitive', async () => {
    const { destination } = setup(github(), { ...appSettings, privateKey: 'not a key' });
    const err = await thrown(destination.invoke(target, {}, run()));
    expect(isInvokeError(err) && err.definitive).toBe(true);
  });

  it('requires the App fields in app mode', () => {
    expect(() =>
      githubActionsDestinationType.create({ auth: 'app', appId: '1' }, createTestContext()),
    ).toThrow(/privateKey/);
    expect(() =>
      githubActionsDestinationType.create({ auth: 'token' }, createTestContext()),
    ).toThrow(/token/);
  });
});
