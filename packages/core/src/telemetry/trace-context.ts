import {
  ROOT_CONTEXT,
  TraceFlags,
  context,
  isSpanContextValid,
  trace,
  type Context,
  type SpanContext,
} from '@opentelemetry/api';

/**
 * W3C `traceparent` values stored with queue jobs and rows (`events.trace_context`,
 * `runs.trace_context`) so that one event reads as one trace across replicas and async jobs.
 * Parsed here rather than through the global propagator, so they work whatever propagators the
 * installation registered.
 */

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function formatTraceparent(sc: SpanContext): string | undefined {
  if (!isSpanContextValid(sc)) return undefined;
  const flags = (sc.traceFlags & 1) === 1 ? '01' : '00';
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

export function parseTraceparent(value: unknown): SpanContext | undefined {
  if (typeof value !== 'string') return undefined;
  const m = TRACEPARENT.exec(value.trim().toLowerCase());
  if (!m) return undefined;
  const sc: SpanContext = {
    traceId: m[1] ?? '',
    spanId: m[2] ?? '',
    traceFlags: parseInt(m[3] ?? '0', 16) & TraceFlags.SAMPLED,
    isRemote: true,
  };
  return isSpanContextValid(sc) ? sc : undefined;
}

/** A context whose parent is the stored span, or undefined when the value is not a traceparent. */
export function contextFromTraceparent(value: unknown): Context | undefined {
  const sc = parseTraceparent(value);
  return sc ? trace.setSpanContext(ROOT_CONTEXT, sc) : undefined;
}

/** The active span's traceparent (undefined outside a span or when tracing is off). */
export function activeTraceparent(): string | undefined {
  const span = trace.getSpan(context.active());
  return span ? formatTraceparent(span.spanContext()) : undefined;
}
