import { describe, expect, it } from 'vitest';

import {
  exportsSignal,
  parseKeyValueList,
  parseOtelConfig,
  telemetryStatus,
} from './otel-config.js';

describe('parseOtelConfig', () => {
  it('exports nothing and serves Prometheus with no configuration', () => {
    const c = parseOtelConfig({});
    expect(c.disabled).toBe(false);
    expect(c.serviceName).toBe('switchboard');
    for (const s of ['traces', 'metrics', 'logs'] as const) {
      expect(c[s].exporters).toEqual([]);
      expect(c[s].otlp).toBeUndefined();
      expect(exportsSignal(c, s)).toBe(false);
    }
    expect(c.metrics.prometheus).toBe(true);
    expect(c.metrics.exportIntervalMillis).toBe(30_000);
    expect(c.traces.sampler).toBe('parentbased_always_on');
    expect(c.warnings).toEqual([]);
  });

  it('appends /v1/<signal> to the generic endpoint, http/protobuf by default', () => {
    const c = parseOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/' });
    expect(c.traces.otlp).toEqual({
      url: 'http://collector:4318/v1/traces',
      protocol: 'http/protobuf',
      headers: {},
      timeoutMillis: 10_000,
      compression: 'none',
    });
    expect(c.metrics.otlp?.url).toBe('http://collector:4318/v1/metrics');
    expect(c.logs.otlp?.url).toBe('http://collector:4318/v1/logs');
    expect(c.logs.exporters).toEqual(['otlp']);
  });

  it('uses a per-signal endpoint as-is and per-signal options over the generic ones', () => {
    const c = parseOtelConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/api/traces',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'grpc',
      OTEL_EXPORTER_OTLP_TIMEOUT: '5000',
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: '2000',
      OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=generic,x-team=core',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-api-key=traces-only',
    });
    expect(c.traces.otlp?.url).toBe('https://traces.example.com/api/traces');
    expect(c.traces.otlp?.protocol).toBe('http/json');
    expect(c.traces.otlp?.headers).toEqual({ 'x-api-key': 'traces-only', 'x-team': 'core' });
    // gRPC has no path: the generic endpoint is used as the base.
    expect(c.metrics.otlp?.url).toBe('http://collector:4318');
    expect(c.metrics.otlp?.protocol).toBe('grpc');
    expect(c.metrics.otlp?.headers).toEqual({ 'x-api-key': 'generic', 'x-team': 'core' });
    expect(c.logs.otlp?.timeoutMillis).toBe(2000);
    expect(c.metrics.otlp?.timeoutMillis).toBe(5000);
    expect(c.logs.otlp?.compression).toBe('gzip');
    expect(c.warnings).toEqual([]);
  });

  it('exports one signal when only its endpoint is set', () => {
    const c = parseOtelConfig({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://loki:3100/otlp/v1/logs',
    });
    expect(c.logs.exporters).toEqual(['otlp']);
    expect(c.traces.exporters).toEqual([]);
    expect(c.metrics.exporters).toEqual([]);
  });

  it('parses headers as W3C baggage: percent-decoded values, malformed members skipped', () => {
    const warnings: string[] = [];
    expect(
      parseKeyValueList(
        'Authorization=Basic%20abc%3D%3D, dd-api-key = k1 ,broken,=nokey',
        'OTEL_EXPORTER_OTLP_HEADERS',
        warnings,
      ),
    ).toEqual({ Authorization: 'Basic abc==', 'dd-api-key': 'k1' });
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).not.toContain('abc');
  });

  it('OTEL_<SIGNAL>_EXPORTER picks exporters; none wins; otlp without an endpoint uses localhost', () => {
    const c = parseOtelConfig({
      OTEL_TRACES_EXPORTER: 'otlp,console',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_LOGS_EXPORTER: 'console',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
    });
    expect(c.traces.exporters).toEqual(['otlp', 'console']);
    expect(c.metrics.exporters).toEqual([]);
    expect(c.metrics.otlp).toBeUndefined();
    expect(c.logs.exporters).toEqual(['console']);
    expect(c.logs.otlp).toBeUndefined();

    const local = parseOtelConfig({ OTEL_TRACES_EXPORTER: 'otlp' });
    expect(local.traces.otlp?.url).toBe('http://localhost:4318/v1/traces');
    const grpc = parseOtelConfig({
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    });
    expect(grpc.traces.otlp?.url).toBe('http://localhost:4317');
  });

  it('Prometheus: SWITCHBOARD_PROMETHEUS, or prometheus in OTEL_METRICS_EXPORTER', () => {
    expect(parseOtelConfig({ SWITCHBOARD_PROMETHEUS: 'false' }).metrics.prometheus).toBe(false);
    expect(
      parseOtelConfig({ SWITCHBOARD_PROMETHEUS: 'false', OTEL_METRICS_EXPORTER: 'prometheus' })
        .metrics.prometheus,
    ).toBe(true);
    const both = parseOtelConfig({
      OTEL_METRICS_EXPORTER: 'prometheus,otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318',
    });
    expect(both.metrics.exporters).toEqual(['otlp']);
    expect(both.metrics.prometheus).toBe(true);
  });

  it('OTEL_SDK_DISABLED turns everything off, Prometheus included', () => {
    const c = parseOtelConfig({
      OTEL_SDK_DISABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
    });
    expect(c.disabled).toBe(true);
    expect(c.metrics.prometheus).toBe(false);
    expect(exportsSignal(c, 'traces')).toBe(false);
    const status = telemetryStatus(c);
    expect(status.enabled).toBe(false);
    expect(status.signals.every((s) => s.exporters.length === 0)).toBe(true);
  });

  it('resource: OTEL_SERVICE_NAME over service.name in OTEL_RESOURCE_ATTRIBUTES', () => {
    const c = parseOtelConfig({
      OTEL_RESOURCE_ATTRIBUTES: 'service.name=from-attrs,deployment.environment.name=prod,team=ops',
    });
    expect(c.serviceName).toBe('from-attrs');
    expect(c.resourceAttributes).toEqual({ 'deployment.environment.name': 'prod', team: 'ops' });
    expect(
      parseOtelConfig({ OTEL_SERVICE_NAME: 'sb-eu', OTEL_RESOURCE_ATTRIBUTES: 'service.name=x' })
        .serviceName,
    ).toBe('sb-eu');
  });

  it('samplers and their ratio', () => {
    const c = parseOtelConfig({
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.25',
    });
    expect(c.traces.sampler).toBe('parentbased_traceidratio');
    expect(c.traces.samplerRatio).toBe(0.25);
    expect(telemetryStatus(c).sampler).toBe('parentbased_traceidratio (0.25)');
    expect(parseOtelConfig({ OTEL_TRACES_SAMPLER: 'always_off' }).traces.sampler).toBe(
      'always_off',
    );
  });

  it('invalid values warn and fall back to the defaults', () => {
    const c = parseOtelConfig({
      OTEL_SDK_DISABLED: 'maybe',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'collector:4318',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'thrift',
      OTEL_EXPORTER_OTLP_TIMEOUT: '-1',
      OTEL_EXPORTER_OTLP_COMPRESSION: 'brotli',
      OTEL_TRACES_EXPORTER: 'otlp,zipkin',
      OTEL_METRIC_EXPORT_INTERVAL: 'soon',
      OTEL_TRACES_SAMPLER: 'jaeger_remote',
    });
    expect(c.disabled).toBe(false);
    // The generic endpoint is not a URL: traces (explicitly otlp) fall back to localhost,
    // metrics and logs (implicit) do not export.
    expect(c.traces.otlp).toEqual({
      url: 'http://localhost:4318/v1/traces',
      protocol: 'http/protobuf',
      headers: {},
      timeoutMillis: 10_000,
      compression: 'none',
    });
    expect(c.metrics.otlp).toBeUndefined();
    expect(c.metrics.exportIntervalMillis).toBe(30_000);
    expect(c.traces.sampler).toBe('parentbased_always_on');
    const text = c.warnings.join('\n');
    for (const name of [
      'OTEL_SDK_DISABLED',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_PROTOCOL',
      'OTEL_EXPORTER_OTLP_TIMEOUT',
      'OTEL_EXPORTER_OTLP_COMPRESSION',
      'zipkin',
      'OTEL_METRIC_EXPORT_INTERVAL',
      'OTEL_TRACES_SAMPLER',
    ]) {
      expect(text).toContain(name);
    }
  });

  it('warns once about a bad generic OTLP value, not once per signal', () => {
    const c = parseOtelConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'thrift',
      OTEL_EXPORTER_OTLP_TIMEOUT: 'soon',
      OTEL_EXPORTER_OTLP_COMPRESSION: 'brotli',
      OTEL_EXPORTER_OTLP_HEADERS: 'novalue',
    });
    expect(c.traces.otlp && c.metrics.otlp && c.logs.otlp).toBeTruthy();
    for (const name of [
      'OTEL_EXPORTER_OTLP_PROTOCOL',
      'OTEL_EXPORTER_OTLP_TIMEOUT',
      'OTEL_EXPORTER_OTLP_COMPRESSION',
      'OTEL_EXPORTER_OTLP_HEADERS',
    ]) {
      expect(c.warnings.filter((w) => w.startsWith(name))).toHaveLength(1);
    }
  });

  it('empty values count as unset', () => {
    const c = parseOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: '', OTEL_SERVICE_NAME: '  ' });
    expect(c.traces.exporters).toEqual([]);
    expect(c.serviceName).toBe('switchboard');
    expect(c.warnings).toEqual([]);
  });
});

describe('telemetryStatus', () => {
  it('shows the endpoint host and a header count, never header values or URL credentials', () => {
    const status = telemetryStatus(
      parseOtelConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:pw@otlp.example.com:4318/prefix?token=t',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=secret-key',
      }),
    );
    const traces = status.signals.find((s) => s.signal === 'traces');
    expect(traces).toEqual({
      signal: 'traces',
      exporters: ['otlp'],
      protocol: 'http/protobuf',
      endpoint: 'https://otlp.example.com:4318',
      headers: 1,
    });
    const json = JSON.stringify(status);
    expect(json).not.toContain('secret-key');
    expect(json).not.toContain('x-honeycomb-team');
    expect(json).not.toContain('pw');
    expect(json).not.toContain('token');
  });
});

describe('OTEL_LOG_LEVEL', () => {
  const cases: { value: string | undefined; level: string; warns: boolean }[] = [
    { value: undefined, level: 'warn', warns: false },
    { value: 'DEBUG', level: 'debug', warns: false },
    { value: 'none', level: 'none', warns: false },
    { value: 'loud', level: 'warn', warns: true },
  ];
  for (const c of cases) {
    it(`${c.value ?? 'unset'} → ${c.level}`, () => {
      const config = parseOtelConfig(c.value === undefined ? {} : { OTEL_LOG_LEVEL: c.value });
      expect(config.diagLevel).toBe(c.level);
      expect(config.warnings.some((w) => w.startsWith('OTEL_LOG_LEVEL'))).toBe(c.warns);
    });
  }
});
