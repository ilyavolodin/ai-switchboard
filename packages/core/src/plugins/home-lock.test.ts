import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { homeLockPath, HomeLockTimeoutError, withHomeLock } from './home-lock.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sb-lock-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function lockExists(): Promise<boolean> {
  try {
    await stat(homeLockPath(home));
    return true;
  } catch {
    return false;
  }
}

async function plantLock(owner: { pid: number; host: string } | undefined, ageMs = 0) {
  const dir = homeLockPath(home);
  await mkdir(dir, { recursive: true });
  if (owner) await writeFile(join(dir, 'owner.json'), JSON.stringify(owner));
  const at = new Date(Date.now() - ageMs);
  await utimes(dir, at, at);
}

describe('withHomeLock', () => {
  it('runs one task at a time and releases the lock', async () => {
    let running = 0;
    let most = 0;
    const task = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    };
    await Promise.all([
      withHomeLock(home, task, { pollMs: 2 }),
      withHomeLock(home, task, { pollMs: 2 }),
      withHomeLock(home, task, { pollMs: 2 }),
    ]);
    expect(most).toBe(1);
    expect(await lockExists()).toBe(false);
  });

  it('releases the lock when the task throws', async () => {
    await expect(withHomeLock(home, () => Promise.reject(new Error('npm failed')))).rejects.toThrow(
      'npm failed',
    );
    expect(await lockExists()).toBe(false);
  });

  it('takes over a lock whose owner on this host has exited', async () => {
    await plantLock({ pid: 2 ** 22 + 12345, host: hostname() });
    await expect(withHomeLock(home, () => Promise.resolve('ran'))).resolves.toBe('ran');
  });

  it('lets only one of several waiters take over a stale lock', async () => {
    await plantLock({ pid: 2 ** 22 + 12345, host: hostname() });
    let running = 0;
    let most = 0;
    const task = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    };
    await Promise.all(Array.from({ length: 5 }, () => withHomeLock(home, task, { pollMs: 2 })));
    expect(most).toBe(1);
    expect(await lockExists()).toBe(false);
  });

  it('judges a lock from another host stale by the injected clock', async () => {
    await plantLock({ pid: 1, host: 'elsewhere' });
    const later = () => Date.now() + 120_000;
    await expect(
      withHomeLock(home, () => Promise.resolve('ran'), {
        staleMs: 60_000,
        waitMs: 50,
        pollMs: 5,
        now: later,
      }),
    ).resolves.toBe('ran');
  });

  it('takes over an old lock from another host', async () => {
    await plantLock({ pid: 1, host: 'elsewhere' }, 60_000);
    await expect(
      withHomeLock(home, () => Promise.resolve('ran'), { staleMs: 1_000 }),
    ).resolves.toBe('ran');
  });

  it('waits for a live holder and gives up after the wait', async () => {
    await plantLock({ pid: process.pid, host: hostname() });
    await expect(
      withHomeLock(home, () => Promise.resolve('ran'), { waitMs: 30, pollMs: 5 }),
    ).rejects.toBeInstanceOf(HomeLockTimeoutError);
  });
});
