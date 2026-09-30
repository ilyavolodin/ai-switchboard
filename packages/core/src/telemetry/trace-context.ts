import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  context,
  isSpanContextValid,
  propagation,
  trace,
  type Context,
  type Link,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';

import { errorText } from '../util/errors.js';

/** The instrumentation scope of every tracer, meter and log emitter the core creates. */
export const SCOPE_NAME = 'switchboard';

/** Records the exception, its type and an error status on the span (the caller ends it). */
export function failSpan(span: Span, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  span.recordException(e);
  span.setAttribute(ATTR_ERROR_TYPE, e.name);
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorText(err) });
}

/** W3C trace context of `ctx` added to `headers`. */
export function injectTraceHeaders(ctx: Context, headers: Headers): Headers {
  propagation.inject(ctx, headers, { set: (carrier, key, value) => carrier.set(key, value) });
  return headers;
}

/** Links to stored traceparents; absent or invalid values are skipped. */
export function linksTo(traceparents: readonly (string | null | undefined)[]): Link[] {
  const links: Link[] = [];
  for (const value of traceparents) {
    const sc = parseTraceparent(value);
    if (sc) links.push({ context: sc });
  }
  return links;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function formatTraceparent(sc: SpanContext): string | undefined {
  if (!isSpanContextValid(sc)) return undefined;
  const flags = (sc.traceFlags & 1) === 1 ? '01' : '00';
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

/**
 * Parsed here rather than through the global propagator, so stored values work whatever
 * propagators the installation registered.
 */
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

export function contextFromTraceparent(value: unknown): Context | undefined {
  const sc = parseTraceparent(value);
  return sc ? trace.setSpanContext(ROOT_CONTEXT, sc) : undefined;
}

export function activeTraceparent(): string | undefined {
  const span = trace.getSpan(context.active());
  return span ? formatTraceparent(span.spanContext()) : undefined;
}
