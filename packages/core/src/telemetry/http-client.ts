import { SpanKind, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
} from '@opentelemetry/semantic-conventions';

/**
 * Outside a recording span it only propagates the active context (an incoming sender's). The URL
 * is recorded without its query string, which may carry a token.
 */
export function createTracedFetch(
  base: typeof fetch = globalThis.fetch,
  tracer = trace.getTracer('switchboard'),
): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const active = context.active();
    if (!trace.getSpan(active)?.isRecording()) {
      const headers = new Headers(init.headers);
      propagation.inject(active, headers, {
        set: (carrier, key, value) => carrier.set(key, value),
      });
      return base(input, { ...init, headers });
    }
    const span = tracer.startSpan(
      method,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [ATTR_HTTP_REQUEST_METHOD]: method,
          [ATTR_URL_FULL]: `${url.origin}${url.pathname}`,
          [ATTR_SERVER_ADDRESS]: url.hostname,
          [ATTR_SERVER_PORT]: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        },
      },
      active,
    );
    const headers = new Headers(init.headers);
    propagation.inject(trace.setSpan(active, span), headers, {
      set: (carrier, key, value) => carrier.set(key, value),
    });
    try {
      const res = await base(input, { ...init, headers });
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, res.status);
      if (res.status >= 400) {
        span.setAttribute(ATTR_ERROR_TYPE, String(res.status));
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      return res;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      span.recordException(e);
      span.setAttribute(ATTR_ERROR_TYPE, e.name);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
      throw err;
    } finally {
      span.end();
    }
  };
}
