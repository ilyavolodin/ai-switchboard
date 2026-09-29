import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  context,
  diag,
  DiagLogLevel,
  metrics,
  propagation,
  trace,
  type DiagLogger,
} from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { OTLPLogExporter as OTLPLogExporterGrpc } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPLogExporter as OTLPLogExporterJson } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OTLPLogExporterProto } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter as OTLPMetricExporterGrpc } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as OTLPMetricExporterJson } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterProto } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter as OTLPTraceExporterGrpc } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OTLPTraceExporterJson } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterProto } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
  type LogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import type { CoreConfig } from '../config.js';
import type { CoreLogger } from '../logger.js';

import { OTEL_DIAG_COMPONENT } from './log-bridge.js';
import {
  telemetryStatus,
  type OtelConfig,
  type OtlpExporterConfig,
  type TelemetryStatus,
} from './otel-config.js';

export interface TelemetryRuntime {
  /** Serves the Prometheus exposition, when enabled. */
  prometheus: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  /** Where each signal goes, for Settings › About (no headers). */
  status: TelemetryStatus;
  /** Export what is buffered (tests, shutdown). */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

function httpOptions(c: OtlpExporterConfig) {
  return {
    url: c.url,
    headers: c.headers,
    timeoutMillis: c.timeoutMillis,
    compression: c.compression as never,
  };
}

/**
 * gRPC exporters take headers as grpc-js `Metadata`; they read `OTEL_EXPORTER_OTLP_[SIGNAL_]HEADERS`
 * from the environment themselves, which is where `OtelConfig` got them.
 */
function grpcOptions(c: OtlpExporterConfig) {
  return { url: c.url, timeoutMillis: c.timeoutMillis, compression: c.compression as never };
}

function spanExporter(c: OtlpExporterConfig): SpanExporter {
  if (c.protocol === 'grpc') return new OTLPTraceExporterGrpc(grpcOptions(c));
  if (c.protocol === 'http/json') return new OTLPTraceExporterJson(httpOptions(c));
  return new OTLPTraceExporterProto(httpOptions(c));
}

function metricExporter(c: OtlpExporterConfig): PushMetricExporter {
  if (c.protocol === 'grpc') return new OTLPMetricExporterGrpc(grpcOptions(c));
  if (c.protocol === 'http/json') return new OTLPMetricExporterJson(httpOptions(c));
  return new OTLPMetricExporterProto(httpOptions(c));
}

function logExporter(c: OtlpExporterConfig): LogRecordExporter {
  if (c.protocol === 'grpc') return new OTLPLogExporterGrpc(grpcOptions(c));
  if (c.protocol === 'http/json') return new OTLPLogExporterJson(httpOptions(c));
  return new OTLPLogExporterProto(httpOptions(c));
}

function sampler(t: OtelConfig['traces']): Sampler {
  const ratio = new TraceIdRatioBasedSampler(t.samplerRatio);
  switch (t.sampler) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return ratio;
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: ratio });
    case 'parentbased_always_on':
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

/** The SDK's own diagnostics (export failures) as pino lines that are never exported themselves. */
function diagLogger(logger: CoreLogger): DiagLogger {
  const log = logger.child({ component: OTEL_DIAG_COMPONENT });
  const line = (level: 'error' | 'warn' | 'info' | 'debug') => (message: string) => {
    log[level](message);
  };
  return {
    error: line('error'),
    warn: line('warn'),
    info: line('info'),
    debug: line('debug'),
    verbose: line('debug'),
  };
}

const DIAG_LEVELS: Record<string, DiagLogLevel> = {
  none: DiagLogLevel.NONE,
  error: DiagLogLevel.ERROR,
  warn: DiagLogLevel.WARN,
  info: DiagLogLevel.INFO,
  debug: DiagLogLevel.DEBUG,
  verbose: DiagLogLevel.VERBOSE,
  all: DiagLogLevel.ALL,
};

function exporterList(exporters: readonly string[] | undefined): string {
  return exporters && exporters.length > 0 ? exporters.join(',') : 'none';
}

/** Unregister every global so a later `setupTelemetry` in the same process starts clean (tests). */
function disableGlobals(): void {
  trace.disable();
  metrics.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
}

/**
 * Register the OpenTelemetry providers from `config.telemetry`: traces, metrics (OTLP push and the
 * Prometheus reader) and logs (the pino bridge emits into the LoggerProvider registered here).
 * The tracer provider is registered even when traces do not export (sampling nothing), so
 * incoming `traceparent` headers still reach plugin HTTP calls and log lines carry trace ids.
 */
export function setupTelemetry(config: CoreConfig, logger?: CoreLogger): TelemetryRuntime {
  const t = config.telemetry;
  const status = telemetryStatus(t);
  const log = logger?.child({ component: 'telemetry' });
  for (const w of t.warnings) log?.warn({ problem: w }, 'telemetry configuration');
  if (t.disabled) {
    log?.info('OpenTelemetry SDK disabled (OTEL_SDK_DISABLED)');
    return {
      prometheus: undefined,
      status,
      flush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
  }
  if (logger) {
    const level = DIAG_LEVELS[(process.env.OTEL_LOG_LEVEL ?? 'warn').toLowerCase()];
    diag.setLogger(diagLogger(logger), {
      logLevel: level ?? DiagLogLevel.WARN,
      suppressOverrideMessage: true,
    });
  }

  const resource = resourceFromAttributes({
    'service.instance.id': config.replicaId,
    ...t.resourceAttributes,
    [ATTR_SERVICE_NAME]: t.serviceName,
    [ATTR_SERVICE_VERSION]: config.version,
  });

  // Traces
  const spanProcessors: SpanProcessor[] = [];
  if (t.traces.otlp) spanProcessors.push(new BatchSpanProcessor(spanExporter(t.traces.otlp)));
  if (t.traces.exporters.includes('console'))
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  const tracerProvider = new NodeTracerProvider({
    resource,
    // Not exported: nothing is recorded, but spans still carry ids, so log lines get trace_id and
    // plugin HTTP calls pass an incoming sender's trace on.
    sampler: spanProcessors.length > 0 ? sampler(t.traces) : new AlwaysOffSampler(),
    spanProcessors,
  });
  tracerProvider.register();

  // Metrics
  const readers: IMetricReader[] = [];
  let prometheus: PrometheusExporter | undefined;
  if (t.metrics.prometheus) {
    prometheus = new PrometheusExporter({ preventServerStart: true });
    readers.push(prometheus);
  }
  const periodic = (exporter: PushMetricExporter) =>
    new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: t.metrics.exportIntervalMillis,
      exportTimeoutMillis: Math.min(t.metrics.exportTimeoutMillis, t.metrics.exportIntervalMillis),
    });
  if (t.metrics.otlp) readers.push(periodic(metricExporter(t.metrics.otlp)));
  if (t.metrics.exporters.includes('console')) readers.push(periodic(new ConsoleMetricExporter()));
  const meterProvider = new MeterProvider({ resource, readers });
  metrics.setGlobalMeterProvider(meterProvider);

  // Logs
  const logProcessors: LogRecordProcessor[] = [];
  if (t.logs.otlp)
    logProcessors.push(new BatchLogRecordProcessor({ exporter: logExporter(t.logs.otlp) }));
  if (t.logs.exporters.includes('console'))
    logProcessors.push(new SimpleLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() }));
  const loggerProvider =
    logProcessors.length > 0
      ? new LoggerProvider({ resource, processors: logProcessors })
      : undefined;
  if (loggerProvider) logs.setGlobalLoggerProvider(loggerProvider);

  log?.info(
    {
      traces: exporterList(status.signals[0]?.exporters),
      metrics: exporterList(status.signals[1]?.exporters),
      logs: exporterList(status.signals[2]?.exporters),
      prometheus: t.metrics.prometheus,
    },
    'telemetry configured',
  );

  return {
    prometheus: prometheus
      ? (req, res) => prometheus.getMetricsRequestHandler(req, res)
      : undefined,
    status,
    flush: async () => {
      await Promise.allSettled([
        tracerProvider.forceFlush(),
        meterProvider.forceFlush(),
        loggerProvider?.forceFlush(),
      ]);
    },
    shutdown: async () => {
      await Promise.allSettled([
        meterProvider.shutdown(),
        tracerProvider.shutdown(),
        loggerProvider?.shutdown(),
      ]);
      disableGlobals();
    },
  };
}
