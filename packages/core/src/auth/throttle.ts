import { createHash } from 'node:crypto';

import { and, gt, inArray, lt } from 'drizzle-orm';

import type { Clock } from '../clock.js';
import type { DbOrTx } from '../db/client.js';
import { loginAttempts } from '../db/schema.js';

/** One throttle key and how many failures it may collect in the window. */
export interface ThrottleLimit {
  key: string;
  max: number;
}

/** The window every limit counts in, and the limits the sign-in routes use. */
export const THROTTLE_WINDOW_MS = 5 * 60_000;
export const MAX_FAILURES_PER_IP = 10;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_PASSWORD_CHANGE = 5;

/** Failed attempts older than this are pruned (well past any window). */
const KEEP_MS = 60 * 60_000;

export interface ThrottleDecision {
  allowed: boolean;
  /** Seconds until the tightest locked key has a free slot again (0 when allowed). */
  retryAfterSeconds: number;
  /** The key that refused, for logs (never shown to the caller). */
  lockedKey?: string;
}

/**
 * The sliding-window rule, pure: a key with `max` or more failures inside the last `windowMs`
 * is locked until the oldest of its last `max` failures leaves the window. `failures` maps a key
 * to the times of its failures (any order).
 */
export function throttleDecision(
  limits: readonly ThrottleLimit[],
  failures: ReadonlyMap<string, readonly Date[]>,
  now: Date,
  windowMs: number = THROTTLE_WINDOW_MS,
): ThrottleDecision {
  const since = now.getTime() - windowMs;
  let worst: { key: string; until: number } | undefined;
  for (const { key, max } of limits) {
    const inWindow = (failures.get(key) ?? [])
      .map((d) => d.getTime())
      .filter((t) => t > since)
      .sort((a, b) => b - a);
    if (inWindow.length < max) continue;
    // The newest `max` failures: the key frees up once the oldest of them ages out.
    const oldestCounted = inWindow[max - 1] ?? now.getTime();
    const until = oldestCounted + windowMs;
    if (!worst || until > worst.until) worst = { key, until };
  }
  if (!worst) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((worst.until - now.getTime()) / 1000)),
    lockedKey: worst.key,
  };
}

/** `email:<sha256>` of the trimmed, lower-cased address: the table never holds an address. */
export function emailKey(email: string): string {
  return `email:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
}

export const ipKey = (ip: string): string => `ip:${ip}`;

/**
 * A brute-force brake for sign-in and password confirmation, counted in Postgres so every
 * replica sees the same failures: a client spreading attempts over replicas gains nothing.
 */
export class AttemptThrottle {
  constructor(
    private readonly db: DbOrTx,
    private readonly clock: Clock,
    private readonly windowMs: number = THROTTLE_WINDOW_MS,
  ) {}

  /** Whether every limit still has room, and if not, how long to wait. */
  async check(limits: readonly ThrottleLimit[]): Promise<ThrottleDecision> {
    const now = this.clock.now();
    if (limits.length === 0) return { allowed: true, retryAfterSeconds: 0 };
    const rows = await this.db
      .select({ key: loginAttempts.key, at: loginAttempts.at })
      .from(loginAttempts)
      .where(
        and(
          inArray(
            loginAttempts.key,
            limits.map((l) => l.key),
          ),
          gt(loginAttempts.at, new Date(now.getTime() - this.windowMs)),
        ),
      );
    const failures = new Map<string, Date[]>();
    for (const r of rows) failures.set(r.key, [...(failures.get(r.key) ?? []), r.at]);
    return throttleDecision(limits, failures, now, this.windowMs);
  }

  /** Record one failure against each key. */
  async fail(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const at = this.clock.now();
    await this.db.insert(loginAttempts).values(keys.map((key) => ({ key, at })));
  }

  /** Forget the failures of these keys (a successful sign-in clears its email, not its IP). */
  async succeed(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db.delete(loginAttempts).where(inArray(loginAttempts.key, [...keys]));
  }
}

/** Drop attempts that no window can count any more (the `auth.prune` job). */
export async function pruneLoginAttempts(db: DbOrTx, now: Date): Promise<void> {
  await db.delete(loginAttempts).where(lt(loginAttempts.at, new Date(now.getTime() - KEEP_MS)));
}
