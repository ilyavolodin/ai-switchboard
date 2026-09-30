import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvokeError } from '@ai-switchboard/sdk';

import {
  attribute,
  callTimeoutMs,
  HEALTH_TIMEOUT_MS,
  PLUGIN_CALL_TIMEOUT_MS,
} from './attribution.js';

interface Target {
  poll(): Promise<string>;
  health(): Promise<string>;
  invoke(): Promise<string>;
  parse(x: number): number;
  refuse(): Promise<string>;
}

const hang = (): Promise<string> => new Promise<string>(() => undefined);

function target(): Target {
  return {
    poll: hang,
    health: hang,
    invoke: hang,
    parse: (x) => x * 2,
    refuse: () => Promise.reject(new InvokeError('bad request', { status: 400, definitive: true })),
  };
}

describe('attribute', () => {
  let errors: { method: string; message: string }[];
  const onError = (err: unknown, method: string) => {
    errors.push({ method, message: err instanceof Error ? err.message : String(err) });
  };

  beforeEach(() => {
    errors = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out a call that never settles and counts it against the plugin', async () => {
    const wrapped = attribute(target(), onError);
    const pending = wrapped.poll().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PLUGIN_CALL_TIMEOUT_MS);
    expect(await pending).toMatchObject({ name: 'TimeoutError' });
    expect(errors).toEqual([
      { method: 'poll', message: `timed out after ${PLUGIN_CALL_TIMEOUT_MS} ms` },
    ]);
  });

  it('gives health checks their own shorter limit', async () => {
    const wrapped = attribute(target(), onError);
    const pending = wrapped.health().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS);
    expect(await pending).toMatchObject({ name: 'TimeoutError' });
    expect(errors.map((e) => e.method)).toEqual(['health']);
  });

  it('never times out invoke, which has its own per-destination limit', async () => {
    const wrapped = attribute(target(), onError);
    let settled = false;
    void wrapped.invoke().finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(PLUGIN_CALL_TIMEOUT_MS * 10);
    expect(settled).toBe(false);
    expect(errors).toEqual([]);
  });

  it('takes the limit from the policy it is given', async () => {
    const wrapped = attribute(target(), onError, { timeoutFor: () => 50 });
    const pending = wrapped.poll().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ message: 'timed out after 50 ms' });
  });

  it('keeps sync methods sync and does not count expected backend errors', async () => {
    const wrapped = attribute(target(), onError);
    expect(wrapped.parse(2)).toBe(4);
    await expect(wrapped.refuse()).rejects.toMatchObject({ name: 'InvokeError' });
    expect(errors).toEqual([]);
  });
});

describe('callTimeoutMs', () => {
  it('is the default, the health limit or none for invoke', () => {
    expect(callTimeoutMs('poll')).toBe(PLUGIN_CALL_TIMEOUT_MS);
    expect(callTimeoutMs('health')).toBe(HEALTH_TIMEOUT_MS);
    expect(callTimeoutMs('invoke')).toBeUndefined();
  });
});
