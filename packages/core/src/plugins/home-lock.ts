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
}

export class HomeLockTimeoutError extends Error {
  override readonly name = 'HomeLockTimeoutError';
}

const DEFAULTS = { waitMs: 10 * 60_000, pollMs: 100, staleMs: 30 * 60_000 };

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

async function isStale(dir: string, staleMs: number): Promise<boolean> {
  const owner = await readOwner(dir);
  if (owner?.host === hostname()) return !alive(owner.pid);
  try {
    return Date.now() - (await stat(dir)).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

async function tryAcquire(dir: string): Promise<boolean> {
  try {
    await mkdir(dir);
  } catch (err) {
    if (isRecord(err) && err.code === 'EEXIST') return false;
    throw err;
  }
  const owner: Owner = { pid: process.pid, host: hostname() };
  await writeFile(join(dir, 'owner.json'), JSON.stringify(owner), 'utf8');
  return true;
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
  const { waitMs, pollMs, staleMs } = { ...DEFAULTS, ...options };
  await mkdir(resolve(home), { recursive: true });
  const dir = homeLockPath(home);
  const deadline = Date.now() + waitMs;
  while (!(await tryAcquire(dir))) {
    if (await isStale(dir, staleMs)) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
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
