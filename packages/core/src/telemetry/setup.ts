import type { IncomingMessage, ServerResponse } from 'node:http';

import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import type { CoreConfig } from '../config.js';

export interface TelemetryRuntime {
  /** Serves the Prometheus exposition, when enabled. */
  prometheus: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  shutdown(): Promise<void>;
}

/**
 * Register OpenTelemetry providers: a Prometheus reader for installations without a collector,
 * and OTLP metrics and traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 */
export function setupTelemetry(config: CoreConfig): TelemetryRuntime {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'switchboard',
    [ATTR_SERVICE_VERSION]: config.version,
    'service.instance.id': config.replicaId,
  });
  const readers: IMetricReader[] = [];
  let prometheus: PrometheusExporter | undefined;
  if (config.metrics.prometheus) {
    prometheus = new PrometheusExporter({ preventServerStart: true });
    readers.push(prometheus);
  }
  const endpoint = config.metrics.otlpEndpoint?.replace(/\/$/, '');
  if (endpoint) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 30_000,
      }),
    );
  }
  const meterProvider = new MeterProvider({ resource, readers });
  metrics.setGlobalMeterProvider(meterProvider);

  const spanProcessors: SpanProcessor[] = endpoint
    ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))]
    : [];
  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors });
  tracerProvider.register();

  return {
    prometheus: prometheus
      ? (req, res) => prometheus.getMetricsRequestHandler(req, res)
      : undefined,
    shutdown: async () => {
      await Promise.allSettled([meterProvider.shutdown(), tracerProvider.shutdown()]);
    },
  };
}
