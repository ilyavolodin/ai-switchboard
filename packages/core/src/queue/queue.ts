import { PgBoss } from 'pg-boss';

import type { CoreLogger } from '../logger.js';

/** Every queue is created with these; `MemoryQueue` in the test helpers mirrors them. */
export const QUEUE_DEFAULTS = {
  retryLimit: 5,
  retryDelaySeconds: 5,
  retryBackoff: true,
  expireInSeconds: 300,
} as const;

export interface SendOptions {
  startAfter?: Date;
  /** With `singletonSeconds`, at most one job per key in each slot of that many seconds. */
  singletonKey?: string;
  singletonSeconds?: number;
  retryLimit?: number;
}

export interface JobInfo {
  id: string;
  retryCount: number;
}

export type JobHandler = (data: Record<string, unknown>, job: JobInfo) => Promise<void>;

export interface WorkOptions {
  concurrency?: number;
  pollingIntervalSeconds?: number;
  /**
   * After this the queue treats the worker as dead and redelivers the job. Jobs that call a
   * plugin's invoke need room for the longest invoke timeout.
   */
  expireInSeconds?: number;
}

/** Jobs carry ids, not payloads, and handlers are idempotent. */
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
        retryLimit: QUEUE_DEFAULTS.retryLimit,
        retryDelay: QUEUE_DEFAULTS.retryDelaySeconds,
        retryBackoff: QUEUE_DEFAULTS.retryBackoff,
        expireInSeconds: expireInSeconds ?? QUEUE_DEFAULTS.expireInSeconds,
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
      ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
      ...(options.singletonKey !== undefined ? { singletonKey: options.singletonKey } : {}),
      ...(options.singletonSeconds !== undefined
        ? { singletonSeconds: options.singletonSeconds }
        : {}),
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
    await this.boss.schedule(name, cron, data, options.tz !== undefined ? { tz: options.tz } : {});
  }
}
