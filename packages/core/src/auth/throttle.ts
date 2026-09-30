import { and, gt, inArray, lt, or, sql } from 'drizzle-orm';

import type { Clock } from '../clock.js';
import type { Db, DbOrTx } from '../db/client.js';
import { loginAttempts } from '../db/schema.js';
import { groupBy } from '../util/collections.js';
import { sha256 } from './crypto.js';

export interface ThrottleLimit {
  key: string;
  max: number;
}

export const THROTTLE_WINDOW_MS = 5 * 60_000;
export const MAX_FAILURES_PER_IP = 10;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_PASSWORD_CHANGE = 5;

const KEEP_MS = 60 * 60_000;

export interface ThrottleDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** For logs; never shown to the caller. */
  lockedKey?: string;
}

/** A key is locked until the oldest of its last `max` failures leaves the window. */
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

/** Hashed so the table never holds an address. */
export function emailKey(email: string): string {
  return `email:${sha256(email.trim().toLowerCase())}`;
}

export const ipKey = (ip: string): string => `ip:${ip}`;

/** An allowed attempt, already counted as a failure until `succeed` withdraws it. */
export interface ThrottleAttempt extends ThrottleDecision {
  attemptIds: number[];
}

/** Counted in Postgres so a client spreading attempts over replicas gains nothing. */
export class AttemptThrottle {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly windowMs: number = THROTTLE_WINDOW_MS,
  ) {}

  /**
   * Checks the limits and, when allowed, records the attempt as a failure in the same transaction,
   * under an advisory lock per key: concurrent guesses are counted one after another, so a burst
   * gets no more tries than the same guesses sent in turn. A refused attempt is not recorded.
   */
  async attempt(limits: readonly ThrottleLimit[]): Promise<ThrottleAttempt> {
    if (limits.length === 0) return { allowed: true, retryAfterSeconds: 0, attemptIds: [] };
    const keys = [...new Set(limits.map((l) => l.key))].sort();
    return this.db.transaction(async (tx) => {
      for (const key of keys) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      }
      const now = this.clock.now();
      const rows = await tx
        .select({ key: loginAttempts.key, at: loginAttempts.at })
        .from(loginAttempts)
        .where(
          and(
            inArray(loginAttempts.key, keys),
            gt(loginAttempts.at, new Date(now.getTime() - this.windowMs)),
          ),
        );
      const decision = throttleDecision(limits, groupDates(rows), now, this.windowMs);
      if (!decision.allowed) return { ...decision, attemptIds: [] };
      const inserted = await tx
        .insert(loginAttempts)
        .values(keys.map((key) => ({ key, at: now })))
        .returning({ id: loginAttempts.id });
      return { ...decision, attemptIds: inserted.map((r) => r.id) };
    });
  }

  /**
   * Withdraws the attempt's own failures and clears the keys given: a sign-in clears its email
   * key, not its address.
   */
  async succeed(attempt: ThrottleAttempt, clearKeys: readonly string[]): Promise<void> {
    const where = [
      ...(attempt.attemptIds.length > 0 ? [inArray(loginAttempts.id, attempt.attemptIds)] : []),
      ...(clearKeys.length > 0 ? [inArray(loginAttempts.key, [...clearKeys])] : []),
    ];
    if (where.length === 0) return;
    await this.db.delete(loginAttempts).where(or(...where));
  }
}

function groupDates(rows: readonly { key: string; at: Date }[]): Map<string, Date[]> {
  return new Map(
    [...groupBy(rows, (r) => r.key)].map(([key, list]) => [key, list.map((r) => r.at)]),
  );
}

export async function pruneLoginAttempts(db: DbOrTx, now: Date): Promise<void> {
  await db.delete(loginAttempts).where(lt(loginAttempts.at, new Date(now.getTime() - KEEP_MS)));
}
