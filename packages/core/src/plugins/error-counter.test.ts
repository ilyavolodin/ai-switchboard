import { describe, expect, it } from 'vitest';

import { silentLogger } from '../logger.js';
import { createRecordingTelemetry } from '../telemetry/telemetry.js';

import type { PluginErrorCounts } from './catalog-store.js';
import { PluginErrorCounter } from './error-counter.js';

function counter(persist?: (name: string, c: PluginErrorCounts) => Promise<void>) {
  const telemetry = createRecordingTelemetry();
  const persisted: { name: string; counts: PluginErrorCounts }[] = [];
  const c = new PluginErrorCounter({
    telemetry,
    logger: silentLogger(),
    flushDelayMs: 60_000,
    persist:
      persist ??
      ((name, counts) => {
        persisted.push({ name, counts: { ...counts } });
        return Promise.resolve();
      }),
  });
  return { c, telemetry, persisted };
}

describe('PluginErrorCounter', () => {
  it('emits one decision per error, with the detail on the log line only', () => {
    const { c, telemetry } = counter();
    c.record('p', 'exception', 'create: boom', { instanceId: 'i1', method: 'create' });
    expect(telemetry.signals).toEqual([
      {
        kind: 'decision',
        name: 'switchboard.plugin.errors',
        value: 1,
        attributes: { plugin: 'p', kind: 'exception' },
        ids: { detail: 'create: boom', instance_id: 'i1', method: 'create' },
      },
    ]);
  });

  it('batches counts per plugin until a flush', async () => {
    const { c, persisted } = counter();
    c.record('p', 'exception');
    c.record('p', 'invalid_event');
    c.record('p', 'invalid_event');
    c.record('q', 'invalid_usage');
    expect(persisted).toEqual([]);
    await c.stop();
    expect(persisted).toEqual([
      { name: 'p', counts: { exception: 1, invalid_event: 2, invalid_usage: 0 } },
      { name: 'q', counts: { exception: 0, invalid_event: 0, invalid_usage: 1 } },
    ]);
    await c.flush();
    expect(persisted).toHaveLength(2);
  });

  it('a failed write does not throw', async () => {
    const { c } = counter(() => Promise.reject(new Error('db down')));
    c.record('p', 'exception');
    await expect(c.stop()).resolves.toBeUndefined();
  });
});
