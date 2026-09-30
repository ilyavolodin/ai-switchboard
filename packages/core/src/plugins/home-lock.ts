import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { isRecord } from '../util/guards.js';

export interface HomeLockOptions {
  /** Give up waiting for another holder after this long. */
  waitMs?: number;
  pollMs?: number;
  /** A lock older than this is taken over even when its owner cannot be checked (another host). */
  staleMs?: number;
  /** Epoch milliseconds (tests). */
  now?: () => number;
}

export class HomeLockTimeoutError extends Error {
  override readonly name = 'HomeLockTimeoutError';
}

const DEFAULTS = { waitMs: 10 * 60_000, pollMs: 100, staleMs: 30 * 60_000, now: Date.now };

/** A takeover guard left by a crashed process is removed after this long. */
const GUARD_STALE_MS = 10_000;

export function homeLockPath(home: string): string {
  return join(resolve(home), 'plugins.npm-lock');
}

interface Owner {
  pid: number;
  host: string;
}

async function readOwner(dir: string): Promise<Owner | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8'));
    if (isRecord(raw) && typeof raw.pid === 'number' && typeof raw.host === 'string')
      return { pid: raw.pid, host: raw.host };
  } catch {
    return undefined;
  }
  return undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isRecord(err) && err.code === 'EPERM';
  }
}

/** Undefined when the directory is gone. */
async function ageOf(dir: string, now: () => number): Promise<number | undefined> {
  try {
    return now() - (await stat(dir)).mtimeMs;
  } catch {
    return undefined;
  }
}

type LockState = 'gone' | 'stale' | 'held';

async function lockState(dir: string, staleMs: number, now: () => number): Promise<LockState> {
  const age = await ageOf(dir, now);
  if (age === undefined) return 'gone';
  const owner = await readOwner(dir);
  if (owner?.host === hostname()) return alive(owner.pid) ? 'held' : 'stale';
  return age > staleMs ? 'stale' : 'held';
}

async function tryMkdir(dir: string): Promise<boolean> {
  try {
    await mkdir(dir);
    return true;
  } catch (err) {
    if (isRecord(err) && err.code === 'EEXIST') return false;
    throw err;
  }
}

async function tryAcquire(dir: string): Promise<boolean> {
  if (!(await tryMkdir(dir))) return false;
  const owner: Owner = { pid: process.pid, host: hostname() };
  await writeFile(join(dir, 'owner.json'), JSON.stringify(owner), 'utf8');
  return true;
}

/**
 * True when the lock is free to take again. A stale lock is removed holding a guard, and only if it
 * is still stale then: two waiters that both saw it stale must not both remove it, or the second
 * deletes the lock the first had just taken.
 */
async function freeIfStale(dir: string, staleMs: number, now: () => number): Promise<boolean> {
  const seen = await lockState(dir, staleMs, now);
  if (seen !== 'stale') return seen === 'gone';
  const guard = `${dir}.takeover`;
  if (!(await tryMkdir(guard))) {
    if (((await ageOf(guard, now)) ?? 0) > GUARD_STALE_MS)
      await rm(guard, { recursive: true, force: true });
    return false;
  }
  try {
    if ((await lockState(dir, staleMs, now)) === 'stale')
      await rm(dir, { recursive: true, force: true });
    return true;
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

/**
 * Runs `task` holding the plugins directory's lock, so npm never runs twice at once in one
 * `$SWITCHBOARD_HOME`: not in one process (an API install and a sync pass), and not across
 * processes (the CLI next to a running server). The lock is a directory, which `mkdir` creates
 * atomically; a holder that died is detected by its pid on this host, or by age elsewhere.
 */
export async function withHomeLock<T>(
  home: string,
  task: () => Promise<T>,
  options: HomeLockOptions = {},
): Promise<T> {
  const { waitMs, pollMs, staleMs, now } = { ...DEFAULTS, ...options };
  await mkdir(resolve(home), { recursive: true });
  const dir = homeLockPath(home);
  const deadline = now() + waitMs;
  while (!(await tryAcquire(dir))) {
    if (await freeIfStale(dir, staleMs, now)) continue;
    if (now() > deadline) {
      throw new HomeLockTimeoutError(
        `another plugin install is still running in ${resolve(home)} (lock ${dir})`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  try {
    return await task();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
