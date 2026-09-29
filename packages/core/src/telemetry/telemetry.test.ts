import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { logs } from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../clock.js';
import { createLogger, silentLogger } from '../logger.js';
import { MemoryQueue } from '../../test/helpers/memory-queue.js';
import { traceQueue } from '../queue/traced.js';

import { createOtelLogStream, LOCAL_ONLY, toLogRecord } from './log-bridge.js';
import { createTelemetry } from './telemetry.js';
import { formatTraceparent, parseTraceparent } from './trace-context.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer('test');
const telemetry = createTelemetry(silentLogger(), undefined, tracer);

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});
afterAll(() => {
  context.disable();
});
beforeEach(() => {
  exporter.reset();
});

const byName = (name: string) => exporter.getFinishedSpans().find((s) => s.name === name);

describe('traceparent', () => {
  it('round-trips and rejects malformed or all-zero values', () => {
    const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const sc = parseTraceparent(tp);
    expect(sc?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(sc && formatTraceparent(sc)).toBe(tp);
    expect(parseTraceparent('00-00000000000000000000000000000000-b7ad6b7169203331-01')).toBe(
      undefined,
    );
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(null)).toBeUndefined();
  });
});

describe('spans', () => {
  it('nests child spans, continues a stored parent and links to stored traces', async () => {
    let stored: string | undefined;
    await telemetry.span('root', { event_id: 'e1' }, async () => {
      stored = telemetry.traceparent();
      await telemetry.childSpan('switchboard.plugin.parse', { plugin: 'p' }, () =>
        Promise.resolve(1),
      );
    });
    expect(stored).toBeDefined();
    await telemetry.span('later', {}, () => Promise.resolve(), { parent: stored });
    await telemetry.span('batch', {}, () => Promise.resolve(), {
      links: [stored, null, 'not-a-traceparent'],
    });

    const root = byName('root');
    const child = byName('switchboard.plugin.parse');
    const later = byName('later');
    const batch = byName('batch');
    expect(child?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    expect(later?.spanContext().traceId).toBe(root?.spanContext().traceId);
    expect(later?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    expect(batch?.spanContext().traceId).not.toBe(root?.spanContext().traceId);
    expect(batch?.links.map((l) => l.context.spanId)).toEqual([root?.spanContext().spanId]);
    expect(root?.attributes.event_id).toBe('e1');
  });

  it('marks a failed span and rethrows; a sync plugin call stays sync', async () => {
    await expect(
      telemetry.span('fails', {}, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(byName('fails')?.status.code).toBe(2);
    let sync: number | undefined;
    await telemetry.span('outer', {}, () => {
      sync = telemetry.childSpan('switchboard.plugin.verify', {}, () => 42);
      expect(() =>
        telemetry.childSpan('switchboard.plugin.verify', {}, () => {
          throw new Error('bad signature');
        }),
      ).toThrow('bad signature');
      return Promise.resolve();
    });
    expect(sync).toBe(42);
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === 'switchboard.plugin.verify'),
    ).toHaveLength(2);
  });

  it('childSpan outside any span only calls (periodic work starts no traces)', () => {
    expect(telemetry.childSpan('switchboard.plugin.health', {}, () => 'ok')).toBe('ok');
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(telemetry.traceparent()).toBeUndefined();
  });
});

describe('traceQueue', () => {
  it('carries the sender trace into the job and runs the handler in a consumer span', async () => {
    const memory = new MemoryQueue(new FakeClock('2026-01-05T09:00:00Z'));
    const queue = traceQueue(memory, telemetry, (name) => name === 'pipeline.match');
    const seen: (string | undefined)[] = [];
    await queue.work('pipeline.match', (data) => {
      seen.push(trace.getSpan(context.active())?.spanContext().traceId);
      expect(data.eventId).toBe('e1');
      return Promise.resolve();
    });
    await queue.work('stats.materialise', () => {
      seen.push(trace.getSpan(context.active())?.spanContext().traceId);
      return Promise.resolve();
    });
    await telemetry.span('switchboard.ingest', {}, async () => {
      await queue.send('pipeline.match', { eventId: 'e1' });
    });
    await queue.send('stats.materialise', {});
    await memory.drain();

    const ingest = byName('switchboard.ingest');
    const consumer = byName('process pipeline.match');
    expect(consumer?.parentSpanContext?.spanId).toBe(ingest?.spanContext().spanId);
    expect(consumer?.attributes.event_id).toBe('e1');
    expect(seen).toEqual([ingest?.spanContext().traceId, undefined]);
    // Housekeeping jobs with no trace to continue get no span.
    expect(byName('process stats.materialise')).toBeUndefined();
  });

  it('an explicit traceparent in the job data (recovery) is kept', async () => {
    const memory = new MemoryQueue(new FakeClock('2026-01-05T09:00:00Z'));
    const queue = traceQueue(memory, telemetry, () => true);
    const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await queue.work('pipeline.invoke', () => Promise.resolve());
    await telemetry.span('recovery', {}, async () => {
      await queue.send('pipeline.invoke', { runId: 'r1', traceparent: tp });
    });
    await memory.drain();
    expect(byName('process pipeline.invoke')?.spanContext().traceId).toBe(
      '0af7651916cd43dd8448eb211c80319c',
    );
  });
});

describe('logs', () => {
  it('maps a pino line to an OTel record: severity, body, attributes, exception', () => {
    const r = toLogRecord({
      level: 'error',
      time: '2026-01-05T09:00:00.000Z',
      service: 'switchboard',
      msg: 'invoke classified',
      run_id: 'r1',
      attempt: 2,
      trace_id: 'abc',
      err: { type: 'Error', message: 'boom', stack: 'Error: boom\n  at x' },
      detail: { a: [1, 'b'] },
    });
    expect(r.severityNumber).toBe(17);
    expect(r.severityText).toBe('ERROR');
    expect(r.body).toBe('invoke classified');
    expect(r.timestamp?.toISOString()).toBe('2026-01-05T09:00:00.000Z');
    expect(r.attributes).toEqual({
      run_id: 'r1',
      attempt: 2,
      'exception.type': 'Error',
      'exception.message': 'boom',
      'exception.stacktrace': 'Error: boom\n  at x',
      detail: { a: [1, 'b'] },
    });
    expect(toLogRecord({ level: 30, msg: 'x' }).severityText).toBe('INFO');
  });

  it('adds trace_id and span_id to lines logged inside a span, redacted as before', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', destination: { write: (l) => lines.push(l) } });
    let sc: { traceId: string; spanId: string } | undefined;
    await telemetry.span('op', {}, () => {
      sc = trace.getSpan(context.active())?.spanContext();
      logger.info({ auth: { token: 'fixture-secret' }, run_id: 'r1' }, 'inside');
      return Promise.resolve();
    });
    logger.info('outside');
    const [inside, outside] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(inside).toMatchObject({ trace_id: sc?.traceId, span_id: sc?.spanId, run_id: 'r1' });
    expect(lines[0]).not.toContain('fixture-secret');
    expect(outside?.trace_id).toBeUndefined();
  });
});

describe('log bridge', () => {
  it('exports pino lines as records with the active trace; skips SDK and local-only lines', async () => {
    const exported = new InMemoryLogRecordExporter();
    logs.setGlobalLoggerProvider(
      new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: exported })] }),
    );
    try {
      const logger = createLogger({
        level: 'info',
        exportLogs: true,
        destination: { write: () => undefined },
      });
      let traceId: string | undefined;
      await telemetry.span('op', {}, () => {
        traceId = trace.getSpan(context.active())?.spanContext().traceId;
        logger.child({ component: 'pipeline' }).info({ run_id: 'r1' }, 'switchboard.runs');
        return Promise.resolve();
      });
      logger.child({ component: 'otel' }).warn('export failed');
      logger.warn({ [LOCAL_ONLY]: true }, 'temporary password: fixture-password');
      const records = exported.getFinishedLogRecords();
      expect(records.map((r) => r.body)).toEqual(['switchboard.runs']);
      expect(records[0]?.spanContext?.traceId).toBe(traceId);
      expect(records[0]?.attributes).toMatchObject({ run_id: 'r1', component: 'pipeline' });
      expect(records[0]?.severityText).toBe('INFO');
      expect(() => createOtelLogStream().write('not json')).not.toThrow();
    } finally {
      logs.disable();
    }
  });
});
