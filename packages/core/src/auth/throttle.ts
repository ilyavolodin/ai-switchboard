import type { Clock } from '../clock.js';

export interface AttemptThrottleOptions {
  /** Failures within `windowMs` that lock a key. */
  max: number;
  windowMs: number;
  /** How long a key stays locked after its `max`-th failure (and after each one while locked). */
  lockMs: number;
  /** Bound on remembered keys, so failures from many addresses cannot grow memory without end. */
  maxKeys: number;
}

const DEFAULTS: AttemptThrottleOptions = {
  max: 5,
  windowMs: 15 * 60_000,
  lockMs: 60_000,
  maxKeys: 10_000,
};

interface Entry {
  n: number;
  first: number;
  until: number;
}

/**
 * A brute-force brake for sign-in and password confirmation, per replica and in memory: it is a
 * speed bump, not state that must survive a restart or be shared between replicas.
 */
export class AttemptThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: AttemptThrottleOptions;

  constructor(
    private readonly clock: Clock,
    options: Partial<AttemptThrottleOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Remembered keys (for tests). */
  get size(): number {
    return this.entries.size;
  }

  locked(key: string): boolean {
    const e = this.entries.get(key);
    return e !== undefined && e.until > this.clock.now().getTime();
  }

  fail(key: string): void {
    const now = this.clock.now().getTime();
    const prev = this.entries.get(key);
    const fresh = !prev || (now - prev.first > this.opts.windowMs && prev.until <= now);
    const e: Entry = fresh ? { n: 1, first: now, until: 0 } : { ...prev, n: prev.n + 1 };
    if (e.n >= this.opts.max) e.until = now + this.opts.lockMs;
    // Re-insert so the map's order is least recently failed first.
    this.entries.delete(key);
    this.entries.set(key, e);
    if (this.entries.size > this.opts.maxKeys) this.evict(now);
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }

  /** Drop expired keys; if still over the bound, the oldest unlocked ones. */
  private evict(now: number): void {
    for (const [k, e] of this.entries) {
      if (e.until <= now && now - e.first > this.opts.windowMs) this.entries.delete(k);
    }
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.opts.maxKeys) return;
      if (e.until <= now) this.entries.delete(k);
    }
  }
}
