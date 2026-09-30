import { describe, expect, it } from 'vitest';

import type { LiveNotifier, LiveSecretProvider } from '../runtime.js';

import { DISABLED } from './builder.js';
import { LiveSet } from './live-set.js';

function notifier(id: string): LiveNotifier {
  return {
    id,
    name: id,
    typeId: 't',
    type: {} as LiveNotifier['type'],
    notifier: {} as LiveNotifier['notifier'],
  };
}

function provider(id: string, name: string): LiveSecretProvider {
  return {
    id,
    name,
    typeId: 'env',
    type: {} as LiveSecretProvider['type'],
    provider: {} as LiveSecretProvider['provider'],
  };
}

const from = (version: number) => ({ kind: 'notifier' as const, version, name: 'n' });

describe('LiveSet', () => {
  it('a later ticket wins whichever build commits first', () => {
    const set = new LiveSet();
    const older = set.ticket();
    const newer = set.ticket();
    expect(set.commit('n1', newer, { kind: 'notifier', live: notifier('n1') }, from(2))).toBe(true);
    expect(
      set.commit('n1', older, { error: { code: 'secret_error', message: 'stale' } }, from(1)),
    ).toBe(false);
    expect(set.get('notifier', 'n1')?.id).toBe('n1');
    expect(set.error('n1')).toBeUndefined();
    expect(set.builtVersions('notifier').get('n1')).toBe(2);
  });

  it('a claim taken before reading the row beats an older build that finishes later', () => {
    const set = new LiveSet();
    const older = set.ticket();
    const reload = set.ticket();
    set.claim('n1', reload);
    expect(set.busy('n1', older)).toBe(true);
    expect(set.commit('n1', older, { kind: 'notifier', live: notifier('n1') }, from(1))).toBe(
      false,
    );
    expect(set.commit('n1', reload, { error: DISABLED }, from(2))).toBe(true);
    expect(set.get('notifier', 'n1')).toBeUndefined();
    expect(set.error('n1')).toEqual(DISABLED);
  });

  it('keeps a live object and an error together (a disabled instance)', () => {
    const set = new LiveSet();
    set.commit(
      'n1',
      set.ticket(),
      { kind: 'notifier', live: notifier('n1'), error: DISABLED },
      from(1),
    );
    expect(set.get('notifier', 'n1')).toBeDefined();
    expect(set.error('n1')).toEqual(DISABLED);
  });

  it('drops the instance when the row is gone', () => {
    const set = new LiveSet();
    set.commit('n1', set.ticket(), { kind: 'notifier', live: notifier('n1') }, from(1));
    set.commit('n1', set.ticket(), undefined, undefined);
    expect(set.get('notifier', 'n1')).toBeUndefined();
    expect(set.builtOf('n1')).toBeUndefined();
  });

  it('indexes secret providers by name and forgets a renamed one', () => {
    const set = new LiveSet();
    const f = { kind: 'secret_provider' as const, version: 1, name: 'vault' };
    set.commit('p1', set.ticket(), { kind: 'secret_provider', live: provider('p1', 'vault') }, f);
    expect(set.provider('vault')?.id).toBe('p1');
    set.commit('p1', set.ticket(), { kind: 'secret_provider', live: provider('p1', 'kv') }, f);
    expect(set.provider('vault')).toBeUndefined();
    expect(set.provider('kv')?.id).toBe('p1');
  });

  it('marks ids pending for the duration of a reload, counting overlaps', async () => {
    const set = new LiveSet();
    const t = set.ticket();
    let release = (): void => undefined;
    const held = set.withPending(['a'], () => new Promise<void>((r) => (release = r)));
    await set.withPending(['a'], () => Promise.resolve());
    expect(set.busy('a', t)).toBe(true);
    release();
    await held;
    expect(set.busy('a', t)).toBe(false);
  });
});
