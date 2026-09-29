export type OtlpProtocol = 'http/protobuf' | 'http/json' | 'grpc';
export type OtelSignal = 'traces' | 'metrics' | 'logs';
export type PushExporter = 'otlp' | 'console';

export interface OtlpExporterConfig {
  /** `<base>/v1/<signal>` for HTTP, the base for gRPC. */
  url: string;
  protocol: OtlpProtocol;
  /** Carry API keys: never log or return them. */
  headers: Record<string, string>;
  timeoutMillis: number;
  compression: 'gzip' | 'none';
}

export type SamplerName =
  | 'always_on'
  | 'always_off'
  | 'traceidratio'
  | 'parentbased_always_on'
  | 'parentbased_always_off'
  | 'parentbased_traceidratio';

export interface SignalConfig {
  exporters: PushExporter[];
  /** Set when `exporters` includes `otlp`. */
  otlp: OtlpExporterConfig | undefined;
}

export interface OtelConfig {
  /** No providers at all (no export, no `/metrics`). */
  disabled: boolean;
  serviceName: string;
  /** Without `service.name`, which is `serviceName`. */
  resourceAttributes: Record<string, string>;
  traces: SignalConfig & { sampler: SamplerName; samplerRatio: number };
  metrics: SignalConfig & {
    prometheus: boolean;
    exportIntervalMillis: number;
    exportTimeoutMillis: number;
  };
  logs: SignalConfig;
  warnings: string[];
}

const SIGNALS: readonly OtelSignal[] = ['traces', 'metrics', 'logs'];
const PROTOCOLS: readonly OtlpProtocol[] = ['http/protobuf', 'http/json', 'grpc'];
const SAMPLERS: readonly SamplerName[] = [
  'always_on',
  'always_off',
  'traceidratio',
  'parentbased_always_on',
  'parentbased_always_off',
  'parentbased_traceidratio',
];

const DEFAULT_TIMEOUT_MS = 10_000;
/** Not the spec's 60 s, which makes one-minute Grafana rates sparse; the heartbeat is 30 s. */
const DEFAULT_METRIC_INTERVAL_MS = 30_000;
const DEFAULT_METRIC_TIMEOUT_MS = 30_000;

type Env = Record<string, string | undefined>;

/** The spec treats an empty value as unset. */
function get(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function bool(env: Env, name: string, fallback: boolean, warnings: string[]): boolean {
  const v = get(env, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  warnings.push(`${name}=${v} is not a boolean; using ${fallback}`);
  return fallback;
}

function positiveInt(env: Env, name: string, fallback: number, warnings: string[]): number {
  const v = get(env, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    warnings.push(`${name}=${v} is not a positive integer (milliseconds); using ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * `key1=value1,key2=value2`, values percent-decoded. Warnings name the key only: header values
 * carry API keys.
 */
export function parseKeyValueList(
  value: string | undefined,
  name: string,
  warnings: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === undefined) return out;
  for (const member of value.split(',')) {
    if (member.trim() === '') continue;
    const eq = member.indexOf('=');
    const key = (eq === -1 ? member : member.slice(0, eq)).trim();
    if (eq === -1 || key === '') {
      warnings.push(`${name}: skipped a member with no key=value (${key || 'empty key'})`);
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(member.slice(eq + 1).trim());
    } catch {
      warnings.push(`${name}: skipped ${key}, its value is not valid percent-encoding`);
      continue;
    }
    out[key] = decoded;
  }
  return out;
}

function url(value: string, name: string, warnings: string[]): string | undefined {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    return value;
  } catch {
    warnings.push(`${name}=${value} is not an http(s) URL; ignored`);
    return undefined;
  }
}

function protocolOf(env: Env, name: string, fallback: OtlpProtocol, warnings: string[]) {
  const v = get(env, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if ((PROTOCOLS as readonly string[]).includes(v)) return v as OtlpProtocol;
  warnings.push(`${name}=${v} is not one of ${PROTOCOLS.join(', ')}; using ${fallback}`);
  return fallback;
}

function compressionOf(env: Env, name: string, fallback: 'gzip' | 'none', warnings: string[]) {
  const v = get(env, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (v === 'gzip' || v === 'none') return v;
  warnings.push(`${name}=${v} is not gzip or none; using ${fallback}`);
  return fallback;
}

function otlpFor(
  env: Env,
  signal: OtelSignal,
  explicit: boolean,
  warnings: string[],
): OtlpExporterConfig | undefined {
  const S = signal.toUpperCase();
  const protocol = protocolOf(
    env,
    `OTEL_EXPORTER_OTLP_${S}_PROTOCOL`,
    protocolOf(env, 'OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf', warnings),
    warnings,
  );
  const signalName = `OTEL_EXPORTER_OTLP_${S}_ENDPOINT`;
  const signalRaw = get(env, signalName);
  const genericRaw = get(env, 'OTEL_EXPORTER_OTLP_ENDPOINT');
  const signalUrl = signalRaw !== undefined ? url(signalRaw, signalName, warnings) : undefined;
  const genericUrl =
    genericRaw !== undefined ? url(genericRaw, 'OTEL_EXPORTER_OTLP_ENDPOINT', warnings) : undefined;
  let target: string | undefined;
  if (signalUrl !== undefined) {
    target = signalUrl;
  } else if (genericUrl !== undefined) {
    target = protocol === 'grpc' ? genericUrl : `${genericUrl.replace(/\/+$/, '')}/v1/${signal}`;
  } else if (explicit) {
    target = protocol === 'grpc' ? 'http://localhost:4317' : `http://localhost:4318/v1/${signal}`;
  } else {
    return undefined;
  }
  const headers = {
    ...parseKeyValueList(
      get(env, 'OTEL_EXPORTER_OTLP_HEADERS'),
      'OTEL_EXPORTER_OTLP_HEADERS',
      warnings,
    ),
    ...parseKeyValueList(
      get(env, `OTEL_EXPORTER_OTLP_${S}_HEADERS`),
      `OTEL_EXPORTER_OTLP_${S}_HEADERS`,
      warnings,
    ),
  };
  return {
    url: target,
    protocol,
    headers,
    timeoutMillis: positiveInt(
      env,
      `OTEL_EXPORTER_OTLP_${S}_TIMEOUT`,
      positiveInt(env, 'OTEL_EXPORTER_OTLP_TIMEOUT', DEFAULT_TIMEOUT_MS, warnings),
      warnings,
    ),
    compression: compressionOf(
      env,
      `OTEL_EXPORTER_OTLP_${S}_COMPRESSION`,
      compressionOf(env, 'OTEL_EXPORTER_OTLP_COMPRESSION', 'none', warnings),
      warnings,
    ),
  };
}

function hasEndpoint(env: Env, signal: OtelSignal): boolean {
  return (
    get(env, 'OTEL_EXPORTER_OTLP_ENDPOINT') !== undefined ||
    get(env, `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`) !== undefined
  );
}

function exportersFor(
  env: Env,
  signal: OtelSignal,
  warnings: string[],
): { exporters: PushExporter[]; explicitOtlp: boolean; prometheus: boolean } {
  const name = `OTEL_${signal.toUpperCase()}_EXPORTER`;
  const raw = get(env, name);
  if (raw === undefined) {
    return {
      exporters: hasEndpoint(env, signal) ? ['otlp'] : [],
      explicitOtlp: false,
      prometheus: false,
    };
  }
  const allowed =
    signal === 'metrics' ? ['otlp', 'console', 'none', 'prometheus'] : ['otlp', 'console', 'none'];
  const exporters = new Set<PushExporter>();
  let prometheus = false;
  for (const item of raw.split(',').map((s) => s.trim().toLowerCase())) {
    if (item === '') continue;
    if (!allowed.includes(item)) {
      warnings.push(`${name}: unknown exporter ${item} ignored (supported: ${allowed.join(', ')})`);
      continue;
    }
    if (item === 'none') continue;
    if (item === 'prometheus') prometheus = true;
    else exporters.add(item as PushExporter);
  }
  // `none` anywhere in the list wins, per spec.
  const none = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes('none');
  return {
    exporters: none ? [] : [...exporters],
    explicitOtlp: !none && exporters.has('otlp'),
    prometheus: !none && prometheus,
  };
}

function samplerOf(env: Env, warnings: string[]): { sampler: SamplerName; ratio: number } {
  const raw = get(env, 'OTEL_TRACES_SAMPLER')?.toLowerCase();
  let sampler: SamplerName = 'parentbased_always_on';
  if (raw !== undefined) {
    if ((SAMPLERS as readonly string[]).includes(raw)) sampler = raw as SamplerName;
    else warnings.push(`OTEL_TRACES_SAMPLER=${raw} is not supported; using parentbased_always_on`);
  }
  let ratio = 1;
  const arg = get(env, 'OTEL_TRACES_SAMPLER_ARG');
  if (arg !== undefined && sampler.endsWith('traceidratio')) {
    const n = Number(arg);
    if (Number.isFinite(n) && n >= 0 && n <= 1) ratio = n;
    else warnings.push(`OTEL_TRACES_SAMPLER_ARG=${arg} is not a ratio between 0 and 1; using 1`);
  }
  return { sampler, ratio };
}

/**
 * An invalid value is never fatal: it adds a warning and the default applies. Unlike the spec,
 * with no OTLP endpoint and no explicit `OTEL_<SIGNAL>_EXPORTER=otlp` a signal does not export
 * over OTLP, so an installation without a collector does not retry `localhost:4318` forever.
 */
export function parseOtelConfig(env: Env): OtelConfig {
  const warnings: string[] = [];
  const disabled = bool(env, 'OTEL_SDK_DISABLED', false, warnings);
  const resourceAttributes = parseKeyValueList(
    get(env, 'OTEL_RESOURCE_ATTRIBUTES'),
    'OTEL_RESOURCE_ATTRIBUTES',
    warnings,
  );
  const serviceName =
    get(env, 'OTEL_SERVICE_NAME') ?? resourceAttributes['service.name'] ?? 'switchboard';
  delete resourceAttributes['service.name'];

  const signal = (s: OtelSignal) => {
    const chosen = exportersFor(env, s, warnings);
    const otlp = chosen.exporters.includes('otlp')
      ? otlpFor(env, s, chosen.explicitOtlp, warnings)
      : undefined;
    return {
      exporters: otlp ? chosen.exporters : chosen.exporters.filter((e) => e !== 'otlp'),
      otlp,
      prometheus: chosen.prometheus,
    };
  };
  const traces = signal('traces');
  const metrics = signal('metrics');
  const logs = signal('logs');
  const { sampler, ratio } = samplerOf(env, warnings);
  return {
    disabled,
    serviceName,
    resourceAttributes,
    traces: { exporters: traces.exporters, otlp: traces.otlp, sampler, samplerRatio: ratio },
    metrics: {
      exporters: metrics.exporters,
      otlp: metrics.otlp,
      prometheus:
        !disabled && (bool(env, 'SWITCHBOARD_PROMETHEUS', true, warnings) || metrics.prometheus),
      exportIntervalMillis: positiveInt(
        env,
        'OTEL_METRIC_EXPORT_INTERVAL',
        DEFAULT_METRIC_INTERVAL_MS,
        warnings,
      ),
      exportTimeoutMillis: positiveInt(
        env,
        'OTEL_METRIC_EXPORT_TIMEOUT',
        DEFAULT_METRIC_TIMEOUT_MS,
        warnings,
      ),
    },
    logs: { exporters: logs.exporters, otlp: logs.otlp },
    warnings,
  };
}

export function exportsSignal(config: OtelConfig, signal: OtelSignal): boolean {
  return !config.disabled && config[signal].exporters.length > 0;
}

/** Never headers or URL credentials. */
export interface TelemetryStatus {
  enabled: boolean;
  serviceName: string;
  prometheus: boolean;
  signals: {
    signal: OtelSignal;
    exporters: PushExporter[];
    protocol: OtlpProtocol | null;
    /** `scheme://host[:port]` only. */
    endpoint: string | null;
    /** A count: names and values are not shown. */
    headers: number;
  }[];
  sampler: string;
}

export function telemetryStatus(config: OtelConfig): TelemetryStatus {
  return {
    enabled: !config.disabled,
    serviceName: config.serviceName,
    prometheus: config.metrics.prometheus,
    signals: SIGNALS.map((s) => {
      const c = config[s];
      const otlp = config.disabled ? undefined : c.otlp;
      let endpoint: string | null = null;
      if (otlp) {
        const u = new URL(otlp.url);
        endpoint = `${u.protocol}//${u.host}`;
      }
      return {
        signal: s,
        exporters: config.disabled ? [] : c.exporters,
        protocol: otlp?.protocol ?? null,
        endpoint,
        headers: otlp ? Object.keys(otlp.headers).length : 0,
      };
    }),
    sampler: config.traces.sampler.endsWith('traceidratio')
      ? `${config.traces.sampler} (${config.traces.samplerRatio})`
      : config.traces.sampler,
  };
}
