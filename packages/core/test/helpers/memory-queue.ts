import type { Clock } from '../../src/clock.js';
import {
  QUEUE_DEFAULTS,
  type JobHandler,
  type JobQueue,
  type SendOptions,
} from '../../src/queue/queue.js';

interface MemoryJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  startAfter: number;
  singleton: string | undefined;
  retryCount: number;
  retryLimit: number;
}

/**
 * A deterministic queue for tests: nothing runs until `drain()`. Retries and singleton slots
 * follow the real queue's defaults (`QUEUE_DEFAULTS`).
 */
export class MemoryQueue implements JobQueue {
  readonly jobs: MemoryJob[] = [];
  readonly completed: { name: string; data: Record<string, unknown> }[] = [];
  readonly failed: { name: string; data: Record<string, unknown>; error: unknown }[] = [];
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules: { name: string; cron: string; data: Record<string, unknown> }[] = [];
  private readonly slots = new Set<string>();
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  send(
    name: string,
    data: Record<string, unknown>,
    options: SendOptions = {},
  ): Promise<string | null> {
    const now = this.clock.now().getTime();
    let singleton: string | undefined;
    if (options.singletonKey && options.singletonSeconds !== undefined) {
      const slot = Math.floor(now / (options.singletonSeconds * 1000));
      singleton = `${name}\u0000${options.singletonKey}\u0000${slot}`;
      if (this.slots.has(singleton)) return Promise.resolve(null);
      this.slots.add(singleton);
    }
    const id = `job-${++this.seq}`;
    this.jobs.push({
      id,
      name,
      data,
      startAfter: (options.startAfter ?? this.clock.now()).getTime(),
      singleton,
      retryCount: 0,
      retryLimit: options.retryLimit ?? QUEUE_DEFAULTS.retryLimit,
    });
    return Promise.resolve(id);
  }

  work(name: string, handler: JobHandler): Promise<void> {
    this.handlers.set(name, handler);
    return Promise.resolve();
  }

  schedule(name: string, cron: string, data: Record<string, unknown> = {}): Promise<void> {
    this.schedules.push({ name, cron, data });
    return Promise.resolve();
  }

  async tick(name?: string): Promise<void> {
    for (const s of this.schedules) {
      if (name === undefined || s.name === name) await this.send(s.name, s.data);
    }
  }

  pending(name?: string): MemoryJob[] {
    return this.jobs.filter((j) => name === undefined || j.name === name);
  }

  /** Runs due jobs (including ones they send) until none are due; returns how many ran. */
  async drain(maxJobs = 10_000): Promise<number> {
    let ran = 0;
    for (;;) {
      const now = this.clock.now().getTime();
      const index = this.jobs.findIndex((j) => j.startAfter <= now && this.handlers.has(j.name));
      if (index === -1) return ran;
      if (ran >= maxJobs)
        throw new Error(`MemoryQueue.drain exceeded ${maxJobs} jobs; is something looping?`);
      const [job] = this.jobs.splice(index, 1);
      if (!job) return ran;
      const handler = this.handlers.get(job.name);
      ran++;
      try {
        await handler?.(job.data, { id: job.id, retryCount: job.retryCount });
        this.completed.push({ name: job.name, data: job.data });
      } catch (error) {
        if (job.retryCount < job.retryLimit) {
          this.jobs.push({
            ...job,
            retryCount: job.retryCount + 1,
            startAfter: now + retryDelayMs(job.retryCount),
          });
        } else {
          this.failed.push({ name: job.name, data: job.data, error });
        }
      }
    }
  }
}

/** pg-boss's `retryBackoff`: the delay doubles with each retry. */
function retryDelayMs(retryCount: number): number {
  return QUEUE_DEFAULTS.retryDelaySeconds * 1000 * 2 ** retryCount;
}
