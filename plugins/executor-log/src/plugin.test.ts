import { isInvokeError } from '@ai-switchboard/sdk';
import {
  createMemoryState,
  createTestContext,
  executorConformanceChecks,
  runConformance,
  runHandle,
} from '@ai-switchboard/sdk/testing';
import { describe, expect, it } from 'vitest';

import plugin, { logExecutorType } from './plugin.js';

runConformance(
  'log executor',
  executorConformanceChecks(logExecutorType, {
    settings: { hourlyLimit: 10 },
    http: () => undefined,
  }),
  {
    describe,
    it,
  },
);

function make(settings: Record<string, unknown> = {}, now = new Date('2026-05-01T10:00:00Z')) {
  const ctx = createTestContext({ state: createMemoryState(), now: () => now });
  return { ctx, executor: logExecutorType.create(settings, ctx) };
}

describe('log executor', () => {
  it('declares no network access', () => {
    expect(plugin.capabilities.network).toEqual([]);
  });

  it('allows its simulated delay plus 10 s to answer, at least 30 s; its log action is idempotent', () => {
    expect(logExecutorType.invokeTimeoutSeconds).toBe(30);
    expect(logExecutorType.invokeTimeoutFor?.({ delayMs: 0 })).toBe(30);
    expect(logExecutorType.invokeTimeoutFor?.({ delayMs: 25_000 })).toBe(35);
    expect(logExecutorType.actions?.find((a) => a.id === 'log')?.idempotent).toBe(true);
  });

  it('logs the invocation and answers with the input', async () => {
    const { ctx, executor } = make();
    const result = await executor.invoke(
      { label: 'demo' },
      { hello: 'world' },
      runHandle({ processName: 'Autofix' }),
    );
    expect(result).toMatchObject({
      status: 'completed',
      result: { logged: true, label: 'demo', input: { hello: 'world' } },
      usage: { invocations: 1, input_bytes: 17 },
    });
    expect(ctx.logs).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'log executor invocation',
        fields: expect.objectContaining({
          process: 'Autofix',
          label: 'demo',
          input: '{"hello":"world"}',
        }),
      }),
    ]);
  });

  it('truncates large inputs in the log line and can omit them', async () => {
    const big = { text: 'x'.repeat(500) };
    const a = make({ maxLoggedBytes: 64 });
    await a.executor.invoke({}, big, runHandle());
    expect(String(a.ctx.logs[0]?.fields.input)).toMatch(/… \(\d+ bytes\)$/);
    const b = make({ logInput: false, level: 'warn' });
    await b.executor.invoke({}, big, runHandle());
    expect(b.ctx.logs[0]).toMatchObject({ level: 'warn' });
    expect(b.ctx.logs[0]?.fields).not.toHaveProperty('input');
  });

  it('simulates every outcome', async () => {
    const { executor } = make();
    await expect(executor.invoke({ outcome: 'error' }, {}, runHandle())).resolves.toMatchObject({
      status: 'failed',
      errors: [expect.any(String)],
    });
    await expect(executor.invoke({ outcome: 'held' }, {}, runHandle())).resolves.toEqual({
      status: 'held',
      reason: 'paused',
    });
    await expect(
      executor.invoke({ outcome: 'rate_limited', retryAfterSeconds: 120 }, {}, runHandle()),
    ).resolves.toMatchObject({
      status: 'failed',
      retryAfterSeconds: 120,
    });
    const err = await executor
      .invoke({ outcome: 'failed' }, {}, runHandle())
      .catch((e: unknown) => e);
    expect(isInvokeError(err) && err.definitive).toBe(true);
  });

  it('rejects an invalid target without sending anything', async () => {
    const { executor } = make();
    const err = await executor
      .invoke({ outcome: 'explode' }, {}, runHandle())
      .catch((e: unknown) => e);
    expect(isInvokeError(err) && err.definitive && !err.sent).toBe(true);
  });

  it('waits for the configured delay', async () => {
    const { executor } = make();
    const started = Date.now();
    await executor.invoke({ delayMs: 50 }, {}, runHandle());
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('reports a simulated hourly meter only when a limit is set', async () => {
    expect(logExecutorType.metersFor?.({})).toEqual([]);
    expect(logExecutorType.metersFor?.({ hourlyLimit: 4 })).toHaveLength(1);
    const { executor } = make({ hourlyLimit: 4 });
    await executor.invoke({}, {}, runHandle());
    await executor.invoke({}, {}, runHandle());
    await executor.invoke({}, {}, runHandle({ dryRun: true }));
    const [reading] = (await executor.readMeters?.()) ?? [];
    expect(reading).toMatchObject({
      id: 'hourly_runs',
      used: 2,
      limit: 4,
      utilization: 50,
      resetsAt: '2026-05-01T11:00:00.000Z',
    });
    expect(await make().executor.readMeters?.()).toEqual([]);
  });

  it('logs from a before/after step', async () => {
    const { ctx, executor } = make();
    await expect(executor.act?.('log', { message: 'before the run' })).resolves.toEqual({
      ok: true,
      message: 'logged',
    });
    expect(ctx.logs.at(-1)).toMatchObject({
      message: 'log executor step',
      fields: { message: 'before the run' },
    });
    await expect(executor.act?.('nope', {})).resolves.toMatchObject({ ok: false });
  });

  it('rejects invalid settings', () => {
    expect(() => make({ level: 'loud' })).toThrow(/Invalid log executor settings/);
  });
});
