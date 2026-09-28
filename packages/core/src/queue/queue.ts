import { PgBoss } from 'pg-boss';

import type { Clock } from '../clock.js';
import type { CoreLogger } from '../logger.js';

const DEFAULT_EXPIRE_SECONDS = 300;

export interface SendOptions {
  /** Do not run before this time. */
  startAfter?: Date;
  /** At most one queued (not yet active) job per key. */
  singletonKey?: string;
  retryLimit?: number;
}

export interface JobInfo {
  id: string;
  retryCount: number;
}

export type JobHandler = (data: Record<string, unknown>, job: JobInfo) => Promise<void>;

export interface WorkOptions {
  /** Parallel handlers per replica. */
  concurrency?: number;
  pollingIntervalSeconds?: number;
  /**
   * How long one job may run before the queue treats its worker as dead and redelivers it
   * (default 300). Jobs that call a plugin's invoke need room for the longest invoke timeout.
   */
  expireInSeconds?: number;
}

/**
 * The job queue. Jobs carry ids, not payloads, and handlers are idempotent (re-read the row, do
 * nothing if the state already moved on). Backed by pg-boss in production and by `MemoryQueue`
 * in tests.
 */
export interface JobQueue {
  send(name: string, data: Record<string, unknown>, options?: SendOptions): Promise<string | null>;
  work(name: string, handler: JobHandler, options?: WorkOptions): Promise<void>;
  /** A cron-driven job that runs exactly once per tick across replicas. */
  schedule(
    name: string,
    cron: string,
    data?: Record<string, unknown>,
    options?: { tz?: string },
  ): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** pg-boss–backed queue. */
export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly created = new Set<string>();

  constructor(
    connectionString: string,
    private readonly logger: CoreLogger,
  ) {
    this.boss = new PgBoss({ connectionString, schema: 'pgboss' });
    this.boss.on('error', (err: unknown) => {
      this.logger.error({ err }, 'job queue error');
    });
  }

  private async ensure(name: string, expireInSeconds?: number): Promise<void> {
    if (this.created.has(name) && expireInSeconds === undefined) return;
    const existing = await this.boss.getQueue(name);
    if (!existing) {
      await this.boss.createQueue(name, {
        retryLimit: 5,
        retryDelay: 5,
        retryBackoff: true,
        expireInSeconds: expireInSeconds ?? DEFAULT_EXPIRE_SECONDS,
      });
    } else if (expireInSeconds !== undefined && existing.expireInSeconds !== expireInSeconds) {
      // Queues outlive releases; bring an existing queue up to the worker's requirement.
      await this.boss.updateQueue(name, { expireInSeconds });
    }
    this.created.add(name);
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  async send(
    name: string,
    data: Record<string, unknown>,
    options: SendOptions = {},
  ): Promise<string | null> {
    await this.ensure(name);
    return this.boss.send(name, data, {
      ...(options.startAfter ? { startAfter: options.startAfter } : {}),
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.retryLimit !== undefined ? { retryLimit: options.retryLimit } : {}),
    });
  }

  async work(name: string, handler: JobHandler, options: WorkOptions = {}): Promise<void> {
    await this.ensure(name, options.expireInSeconds);
    await this.boss.work<Record<string, unknown>>(
      name,
      {
        localConcurrency: options.concurrency ?? 2,
        pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
        batchSize: 1,
      },
      async (jobs) => {
        for (const job of jobs) {
          await handler(job.data, { id: job.id, retryCount: job.retryCount });
        }
      },
    );
  }

  async schedule(
    name: string,
    cron: string,
    data: Record<string, unknown> = {},
    options: { tz?: string } = {},
  ): Promise<void> {
    await this.ensure(name);
    await this.boss.schedule(name, cron, data, options.tz ? { tz: options.tz } : {});
  }
}

interface MemoryJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  startAfter: number;
  singletonKey: string | undefined;
  retryCount: number;
  retryLimit: number;
}

/**
 * A deterministic in-process queue for tests. Nothing runs until `drain()` is called; `drain`
 * runs every job whose `startAfter` is at or before the clock, including jobs those jobs send,
 * until the queue is quiet. Failed jobs are retried up to their retry limit on later drains.
 */
export class MemoryQueue implements JobQueue {
  readonly jobs: MemoryJob[] = [];
  readonly completed: { name: string; data: Record<string, unknown> }[] = [];
  readonly failed: { name: string; data: Record<string, unknown>; error: unknown }[] = [];
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules: { name: string; cron: string; data: Record<string, unknown> }[] = [];
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
    if (
      options.singletonKey &&
      this.jobs.some((j) => j.name === name && j.singletonKey === options.singletonKey)
    ) {
      return Promise.resolve(null);
    }
    const id = `job-${++this.seq}`;
    this.jobs.push({
      id,
      name,
      data,
      startAfter: (options.startAfter ?? this.clock.now()).getTime(),
      singletonKey: options.singletonKey,
      retryCount: 0,
      retryLimit: options.retryLimit ?? 3,
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

  /** Enqueue one run of every scheduled job (tests call this to simulate a cron tick). */
  async tick(name?: string): Promise<void> {
    for (const s of this.schedules) {
      if (name === undefined || s.name === name) await this.send(s.name, s.data);
    }
  }

  pending(name?: string): MemoryJob[] {
    return this.jobs.filter((j) => name === undefined || j.name === name);
  }

  /** Run due jobs until none are due. Returns how many ran. */
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
          this.jobs.push({ ...job, retryCount: job.retryCount + 1, startAfter: now + 1 });
        } else {
          this.failed.push({ name: job.name, data: job.data, error });
        }
      }
    }
  }
}
