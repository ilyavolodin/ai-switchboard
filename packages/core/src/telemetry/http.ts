import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Span,
} from '@opentelemetry/api';
import {
  ATTR_CLIENT_ADDRESS,
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVER_ADDRESS,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

const TRACED_PREFIXES = ['/api/', '/hooks/', '/callbacks/'];

function traced(url: string): boolean {
  return TRACED_PREFIXES.some((p) => url.startsWith(p));
}

interface Inflight {
  span: Span;
  start: bigint;
}

export function registerHttpTelemetry(app: FastifyInstance): void {
  const tracer = trace.getTracer('switchboard');
  const duration = metrics.getMeter('switchboard').createHistogram('http.server.request.duration', {
    unit: 's',
    description: 'Duration of HTTP server requests.',
    advice: { explicitBucketBoundaries: HTTP_DURATION_BUCKETS },
  });
  const inflight = new WeakMap<FastifyRequest, Inflight>();

  app.addHook('onRequest', (req, _reply, done) => {
    if (!traced(req.url)) {
      done();
      return;
    }
    const parent = propagation.extract(ROOT_CONTEXT, req.headers);
    const span = tracer.startSpan(
      req.method,
      {
        kind: SpanKind.SERVER,
        attributes: {
          [ATTR_HTTP_REQUEST_METHOD]: req.method,
          [ATTR_URL_PATH]: req.url.split('?')[0] ?? req.url,
          [ATTR_URL_SCHEME]: req.protocol,
          [ATTR_SERVER_ADDRESS]: req.hostname,
          [ATTR_CLIENT_ADDRESS]: req.ip,
          ...(req.headers['user-agent']
            ? { [ATTR_USER_AGENT_ORIGINAL]: req.headers['user-agent'] }
            : {}),
        },
      },
      parent,
    );
    inflight.set(req, { span, start: process.hrtime.bigint() });
    // The rest of the hooks run inside the span too, as far as Node's async context carries it;
    // route handlers are wrapped explicitly below, since body parsing can lose it.
    context.with(trace.setSpan(parent, span), done);
  });

  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = function (this: FastifyInstance, req, reply) {
      const f = inflight.get(req);
      if (!f) return handler.call(this, req, reply);
      return context.with(trace.setSpan(context.active(), f.span), () =>
        handler.call(this, req, reply),
      );
    };
  });

  app.addHook('onError', (req, _reply, err, done) => {
    const f = inflight.get(req);
    if (f) {
      f.span.recordException(err);
      f.span.setAttribute(ATTR_ERROR_TYPE, err.name);
    }
    done();
  });

  const finish = (req: FastifyRequest, status: number | undefined): void => {
    const f = inflight.get(req);
    if (!f) return;
    inflight.delete(req);
    const route = req.routeOptions.url;
    const attrs: Record<string, string | number> = {
      [ATTR_HTTP_REQUEST_METHOD]: req.method,
      [ATTR_URL_SCHEME]: req.protocol,
      ...(route ? { [ATTR_HTTP_ROUTE]: route } : {}),
      ...(status !== undefined ? { [ATTR_HTTP_RESPONSE_STATUS_CODE]: status } : {}),
    };
    if (status === undefined) attrs[ATTR_ERROR_TYPE] = 'aborted';
    else if (status >= 500) attrs[ATTR_ERROR_TYPE] = String(status);
    f.span.updateName(route ? `${req.method} ${route}` : req.method);
    f.span.setAttributes(attrs);
    if (status === undefined || status >= 500) f.span.setStatus({ code: SpanStatusCode.ERROR });
    f.span.end();
    duration.record(Number(process.hrtime.bigint() - f.start) / 1e9, attrs);
  };

  app.addHook('onResponse', (req, reply, done) => {
    finish(req, reply.statusCode);
    done();
  });
  app.addHook('onRequestAbort', (req, done) => {
    finish(req, undefined);
    done();
  });
}
