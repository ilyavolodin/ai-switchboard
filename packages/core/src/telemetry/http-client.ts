import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
} from '@opentelemetry/semantic-conventions';

import { failSpan, injectTraceHeaders, SCOPE_NAME } from './trace-context.js';

/**
 * Outside a recording span it only propagates the active context (an incoming sender's). The URL
 * is recorded without its query string, which may carry a token.
 */
export function createTracedFetch(
  base: typeof fetch = globalThis.fetch,
  tracer = trace.getTracer(SCOPE_NAME),
): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const active = context.active();
    if (!trace.getSpan(active)?.isRecording()) {
      return base(input, {
        ...init,
        headers: injectTraceHeaders(active, new Headers(init.headers)),
      });
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
    const headers = injectTraceHeaders(trace.setSpan(active, span), new Headers(init.headers));
    try {
      const res = await base(input, { ...init, headers });
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, res.status);
      if (res.status >= 400) {
        span.setAttribute(ATTR_ERROR_TYPE, String(res.status));
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      return res;
    } catch (err) {
      failSpan(span, err);
      throw err;
    } finally {
      span.end();
    }
  };
}
