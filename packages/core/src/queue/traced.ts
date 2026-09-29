import { SpanKind } from '@opentelemetry/api';

import type { SignalAttributes, Telemetry } from '../telemetry/telemetry.js';

import type { JobQueue } from './queue.js';

// A sender may set `traceparent` itself (recovery continues a run's trace); otherwise `send` adds
// the active span's.
export const TRACEPARENT_KEY = 'traceparent';

const ID_ATTRIBUTES: Record<string, string> = {
  eventId: 'event_id',
  batchId: 'batch_id',
  runId: 'run_id',
  sourceId: 'source_id',
  destinationId: 'destination_id',
};

export function traceQueue(
  queue: JobQueue,
  telemetry: Telemetry,
  isTraced: (name: string) => boolean,
): JobQueue {
  return {
    send: (name, data, options) => {
      const traceparent = data[TRACEPARENT_KEY] === undefined ? telemetry.traceparent() : undefined;
      return queue.send(
        name,
        traceparent !== undefined ? { ...data, [TRACEPARENT_KEY]: traceparent } : data,
        options,
      );
    },
    work: (name, handler, options) =>
      queue.work(
        name,
        (data, job) => {
          const parent = typeof data[TRACEPARENT_KEY] === 'string' ? data[TRACEPARENT_KEY] : null;
          if (!isTraced(name) && parent === null) return handler(data, job);
          const attributes: SignalAttributes = {
            'messaging.system': 'pg-boss',
            'messaging.operation.type': 'process',
            'messaging.destination.name': name,
            'messaging.message.id': job.id,
            'switchboard.job.retry_count': job.retryCount,
          };
          for (const [key, attr] of Object.entries(ID_ATTRIBUTES)) {
            const v = data[key];
            if (typeof v === 'string') attributes[attr] = v;
          }
          return telemetry.span(`process ${name}`, attributes, () => handler(data, job), {
            kind: SpanKind.CONSUMER,
            parent,
          });
        },
        options,
      ),
    schedule: (name, cron, data, options) => queue.schedule(name, cron, data, options),
    start: () => queue.start(),
    stop: () => queue.stop(),
  };
}
