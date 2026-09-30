import {
  context,
  metrics,
  propagation,
  trace,
  SpanKind,
  type Attributes as OtelAttributes,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

import type { CoreLogger } from '../logger.js';

import { createTracedFetch } from './http-client.js';
import {
  activeTraceparent,
  contextFromTraceparent,
  failSpan,
  linksTo,
  SCOPE_NAME,
} from './trace-context.js';

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
  'switchboard.destination.health',
] as const;
export type GaugeName = (typeof GAUGES)[number];

/**
 * Bucket boundaries (seconds) per histogram. Latency includes the batch debounce and approvals;
 * duration covers runs that track for hours; schedule lag is usually seconds.
 */
export const HISTOGRAM_BUCKETS: Record<HistogramName, number[]> = {
  'switchboard.run.latency': [
    0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21_600, 86_400,
  ],
  'switchboard.run.duration': [
    0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21_600, 86_400,
  ],
  'switchboard.schedule.lag': [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 3600],
};

export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

export type SignalAttributes = Record<string, string | number | boolean | undefined>;

export interface SpanOptions {
  kind?: SpanKind;
  /**
   * Continue this trace (a stored W3C traceparent) instead of the active context. An absent or
   * invalid value falls back to the active context.
   */
  parent?: string | null;
  /** Link to these traces (stored traceparents); absent or invalid values are skipped. */
  links?: readonly (string | null | undefined)[];
}

/** The running span, for attributes only known once the work is done. */
export interface SpanHandle {
  setAttributes(attributes: SignalAttributes): void;
  /** Link to these traces (stored traceparents); absent or invalid values are skipped. */
  addLinks(traceparents: readonly (string | null | undefined)[]): void;
}

export interface Telemetry {
  counter(name: CounterName, attributes: SignalAttributes, value?: number): void;
  histogram(name: HistogramName, value: number, attributes: SignalAttributes): void;
  /** The last value per attribute set is reported until it is replaced or cleared. */
  gauge(name: GaugeName, value: number, attributes: SignalAttributes): void;
  /** Stops reporting a series (a deleted instance), so it does not report its last value forever. */
  clearGauge(name: GaugeName, attributes: SignalAttributes): void;
  /**
   * One metric and one structured log line per pipeline decision, with the same attributes.
   * `ids` (event_id, process_id, batch_id, run_id, external_url) go on the log line only.
   */
  decision(
    name: CounterName,
    attributes: SignalAttributes,
    ids?: Record<string, string | undefined>,
  ): void;
  /** Run `fn` inside an active span; exceptions mark the span failed and are rethrown. */
  span<T>(
    name: string,
    attributes: SignalAttributes,
    fn: (span: SpanHandle) => Promise<T>,
    options?: SpanOptions,
  ): Promise<T>;
  /**
   * Run a sync or async call in a child span of the active span (a plugin call). With no active
   * span it just calls, so periodic work (health checks) does not start traces of its own.
   */
  childSpan<T>(name: string, attributes: SignalAttributes, fn: () => T): T;
  /** W3C trace context headers of the active context. */
  traceHeaders(): Record<string, string>;
  /** The active span as a W3C traceparent, for job data and rows; undefined outside a span. */
  traceparent(): string | undefined;
  /** Add attributes to the active span (ids known only once the work ran). */
  annotate(attributes: Record<string, string | number | boolean | string[] | undefined>): void;
  /** `fetch` that records a client span and propagates the active trace (plugin HTTP calls). */
  tracedFetch(): typeof fetch;
  /** `http.server.request.duration`, in seconds, with OTel HTTP semantic attributes. */
  httpServerDuration(seconds: number, attributes: SignalAttributes): void;
}

function clean(attrs: SignalAttributes): OtelAttributes {
  const out: OtelAttributes = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v;
  return out;
}

/** Telemetry over the global OpenTelemetry API (providers are registered in `telemetry/setup.ts`). */
/** Ends `span` when `out` settles (or at once for a plain value), failing it on a rejection. */
function endWith<T>(span: Span, out: T): T {
  if (!(out instanceof Promise)) {
    span.end();
    return out;
  }
  return out.then(
    (value: unknown) => {
      span.end();
      return value;
    },
    (err: unknown) => {
      failSpan(span, err);
      span.end();
      throw err;
    },
  ) as T;
}

/** Runs `fn` in `span`: a throw fails and ends it, a result ends it when it settles. */
function runInSpan<T>(span: Span, parent: ReturnType<typeof context.active>, fn: () => T): T {
  let out: T;
  try {
    out = context.with(trace.setSpan(parent, span), fn);
  } catch (err) {
    failSpan(span, err);
    span.end();
    throw err;
  }
  return endWith(span, out);
}

export function createTelemetry(
  logger: CoreLogger,
  meter: Meter = metrics.getMeter(SCOPE_NAME),
  tracer: Tracer = trace.getTracer(SCOPE_NAME),
): Telemetry {
  const counters = new Map(COUNTERS.map((n) => [n, meter.createCounter(n)]));
  const histograms = new Map(
    HISTOGRAMS.map((n) => [
      n,
      meter.createHistogram(n, {
        unit: 's',
        advice: { explicitBucketBoundaries: HISTOGRAM_BUCKETS[n] },
      }),
    ]),
  );
  const gaugeValues = new Map<GaugeName, Map<string, { value: number; attrs: OtelAttributes }>>();
  for (const name of GAUGES) {
    const values = new Map<string, { value: number; attrs: OtelAttributes }>();
    gaugeValues.set(name, values);
    meter.createObservableGauge(name).addCallback((result) => {
      for (const { value, attrs } of values.values()) result.observe(value, attrs);
    });
  }
  const httpDuration = meter.createHistogram('http.server.request.duration', {
    unit: 's',
    description: 'Duration of HTTP server requests.',
    advice: { explicitBucketBoundaries: HTTP_DURATION_BUCKETS },
  });
  const log = logger.child({ component: 'pipeline' });

  return {
    counter: (name, attributes, value = 1) => counters.get(name)?.add(value, clean(attributes)),
    histogram: (name, value, attributes) => histograms.get(name)?.record(value, clean(attributes)),
    gauge: (name, value, attributes) => {
      const attrs = clean(attributes);
      gaugeValues.get(name)?.set(JSON.stringify(attrs), { value, attrs });
    },
    clearGauge: (name, attributes) => {
      gaugeValues.get(name)?.delete(JSON.stringify(clean(attributes)));
    },
    decision: (name, attributes, ids = {}) => {
      counters.get(name)?.add(1, clean(attributes));
      const fields: Record<string, unknown> = { signal: name, ...clean(attributes) };
      for (const [k, v] of Object.entries(ids)) if (v !== undefined) fields[k] = v;
      log.info(fields, name);
    },
    span: (name, attributes, fn, options = {}) => {
      const parent = contextFromTraceparent(options.parent) ?? context.active();
      const links = linksTo(options.links ?? []);
      const span = tracer.startSpan(
        name,
        {
          kind: options.kind ?? SpanKind.INTERNAL,
          attributes: clean(attributes),
          ...(links.length > 0 ? { links } : {}),
        },
        parent,
      );
      return runInSpan(span, parent, () =>
        fn({
          setAttributes: (a) => span.setAttributes(clean(a)),
          addLinks: (list) => span.addLinks(linksTo(list)),
        }),
      );
    },
    childSpan: (name, attributes, fn) => {
      const active = context.active();
      if (!trace.getSpan(active)?.isRecording()) return fn();
      return runInSpan(
        tracer.startSpan(name, { attributes: clean(attributes) }, active),
        active,
        fn,
      );
    },
    traceHeaders: () => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      return carrier;
    },
    traceparent: activeTraceparent,
    annotate: (attributes) => {
      const span = trace.getSpan(context.active());
      if (!span?.isRecording()) return;
      for (const [k, v] of Object.entries(attributes)) if (v !== undefined) span.setAttribute(k, v);
    },
    tracedFetch: () => createTracedFetch(globalThis.fetch, tracer),
    httpServerDuration: (seconds, attributes) => httpDuration.record(seconds, clean(attributes)),
  };
}

export interface RecordedSignal {
  kind: 'counter' | 'histogram' | 'gauge' | 'gauge_cleared' | 'decision' | 'http';
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
    clearGauge: (name, attributes) =>
      signals.push({ kind: 'gauge_cleared', name, value: 0, attributes }),
    decision: (name, attributes, ids) =>
      signals.push({ kind: 'decision', name, value: 1, attributes, ...(ids ? { ids } : {}) }),
    span: (_name, _attributes, fn) =>
      fn({ setAttributes: () => undefined, addLinks: () => undefined }),
    childSpan: (_name, _attributes, fn) => fn(),
    traceHeaders: () => ({}),
    traceparent: () => undefined,
    annotate: () => undefined,
    tracedFetch: () => (input, init) => globalThis.fetch(input, init),
    httpServerDuration: (seconds, attributes) =>
      signals.push({
        kind: 'http',
        name: 'http.server.request.duration',
        value: seconds,
        attributes,
      }),
  };
}
