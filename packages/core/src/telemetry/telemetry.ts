import {
  context,
  metrics,
  propagation,
  trace,
  SpanStatusCode,
  type Attributes as OtelAttributes,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';

import type { CoreLogger } from '../logger.js';

/** Signal names from the TDD's Observability table. */
export const COUNTERS = [
  'switchboard.events',
  'switchboard.dispatches',
  'switchboard.batches',
  'switchboard.runs',
  'switchboard.run.usage',
  'switchboard.plugin.errors',
  'switchboard.instance.rebuilds',
  'switchboard.heartbeat',
] as const;
export type CounterName = (typeof COUNTERS)[number];

export const HISTOGRAMS = [
  'switchboard.run.latency',
  'switchboard.run.duration',
  'switchboard.schedule.lag',
] as const;
export type HistogramName = (typeof HISTOGRAMS)[number];

export const GAUGES = [
  'switchboard.meter.utilization',
  'switchboard.meter.resets_in',
  'switchboard.budget.used',
  'switchboard.breaker',
  'switchboard.source.health',
  'switchboard.executor.health',
] as const;
export type GaugeName = (typeof GAUGES)[number];

export type SignalAttributes = Record<string, string | number | boolean | undefined>;

export interface Telemetry {
  counter(name: CounterName, attributes: SignalAttributes, value?: number): void;
  histogram(name: HistogramName, value: number, attributes: SignalAttributes): void;
  gauge(name: GaugeName, value: number, attributes: SignalAttributes): void;
  /**
   * One metric and one structured log line per pipeline decision, with the same attributes.
   * `ids` (event_id, process_id, batch_id, run_id, external_url) go on the log line only.
   */
  decision(
    name: CounterName,
    attributes: SignalAttributes,
    ids?: Record<string, string | undefined>,
  ): void;
  /** Run `fn` inside a span; exceptions mark the span failed and are rethrown. */
  span<T>(name: string, attributes: SignalAttributes, fn: () => Promise<T>): Promise<T>;
  /** W3C trace context headers for outbound plugin HTTP calls. */
  traceHeaders(): Record<string, string>;
}

function clean(attrs: SignalAttributes): OtelAttributes {
  const out: OtelAttributes = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v;
  return out;
}

/** Telemetry over the global OpenTelemetry API (providers are registered in `telemetry/setup.ts`). */
export function createTelemetry(
  logger: CoreLogger,
  meter: Meter = metrics.getMeter('switchboard'),
  tracer: Tracer = trace.getTracer('switchboard'),
): Telemetry {
  const counters = new Map(COUNTERS.map((n) => [n, meter.createCounter(n)]));
  const histograms = new Map(HISTOGRAMS.map((n) => [n, meter.createHistogram(n, { unit: 's' })]));
  const gaugeValues = new Map<GaugeName, Map<string, { value: number; attrs: OtelAttributes }>>();
  for (const name of GAUGES) {
    const values = new Map<string, { value: number; attrs: OtelAttributes }>();
    gaugeValues.set(name, values);
    meter.createObservableGauge(name).addCallback((result) => {
      for (const { value, attrs } of values.values()) result.observe(value, attrs);
    });
  }
  const log = logger.child({ component: 'pipeline' });

  return {
    counter: (name, attributes, value = 1) => counters.get(name)?.add(value, clean(attributes)),
    histogram: (name, value, attributes) => histograms.get(name)?.record(value, clean(attributes)),
    gauge: (name, value, attributes) => {
      const attrs = clean(attributes);
      gaugeValues.get(name)?.set(JSON.stringify(attrs), { value, attrs });
    },
    decision: (name, attributes, ids = {}) => {
      counters.get(name)?.add(1, clean(attributes));
      const fields: Record<string, unknown> = { signal: name, ...clean(attributes) };
      for (const [k, v] of Object.entries(ids)) if (v !== undefined) fields[k] = v;
      log.info(fields, name);
    },
    span: async (name, attributes, fn) =>
      tracer.startActiveSpan(name, { attributes: clean(attributes) }, async (span) => {
        try {
          return await fn();
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      }),
    traceHeaders: () => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      return carrier;
    },
  };
}

export interface RecordedSignal {
  kind: 'counter' | 'histogram' | 'gauge' | 'decision';
  name: string;
  value: number;
  attributes: SignalAttributes;
  ids?: Record<string, string | undefined>;
}

/** Records every signal in memory; for tests that assert "one metric per decision". */
export function createRecordingTelemetry(): Telemetry & { signals: RecordedSignal[] } {
  const signals: RecordedSignal[] = [];
  return {
    signals,
    counter: (name, attributes, value = 1) =>
      signals.push({ kind: 'counter', name, value, attributes }),
    histogram: (name, value, attributes) =>
      signals.push({ kind: 'histogram', name, value, attributes }),
    gauge: (name, value, attributes) => signals.push({ kind: 'gauge', name, value, attributes }),
    decision: (name, attributes, ids) =>
      signals.push({ kind: 'decision', name, value: 1, attributes, ...(ids ? { ids } : {}) }),
    span: (_name, _attributes, fn) => fn(),
    traceHeaders: () => ({}),
  };
}
