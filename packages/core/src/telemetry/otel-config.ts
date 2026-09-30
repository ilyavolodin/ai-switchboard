import { isOneOf } from '@ai-switchboard/sdk/json';

export const OTEL_SIGNALS = ['traces', 'metrics', 'logs'] as const;
export type OtelSignal = (typeof OTEL_SIGNALS)[number];

export const OTLP_PROTOCOLS = ['http/protobuf', 'http/json', 'grpc'] as const;
export type OtlpProtocol = (typeof OTLP_PROTOCOLS)[number];

export const OTLP_COMPRESSIONS = ['gzip', 'none'] as const;
export type OtlpCompression = (typeof OTLP_COMPRESSIONS)[number];

export type PushExporter = 'otlp' | 'console';

export const SAMPLERS = [
  'always_on',
  'always_off',
  'traceidratio',
  'parentbased_always_on',
  'parentbased_always_off',
  'parentbased_traceidratio',
] as const;
export type SamplerName = (typeof SAMPLERS)[number];

export const DIAG_LEVELS = ['none', 'error', 'warn', 'info', 'debug', 'verbose', 'all'] as const;
export type DiagLevel = (typeof DIAG_LEVELS)[number];

export interface OtlpExporterConfig {
  /** `<base>/v1/<signal>` for HTTP, the base for gRPC. */
  url: string;
  protocol: OtlpProtocol;
  /** Carry API keys: never log or return them. */
  headers: Record<string, string>;
  timeoutMillis: number;
  compression: OtlpCompression;
}

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
  /** `OTEL_LOG_LEVEL`: the OTel SDK's own diagnostics. */
  diagLevel: DiagLevel;
  warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Not the spec's 60 s, which makes one-minute Grafana rates sparse; the heartbeat is 30 s. */
const DEFAULT_METRIC_INTERVAL_MS = 30_000;
const DEFAULT_METRIC_TIMEOUT_MS = 30_000;

type Env = Record<string, string | undefined>;

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

/**
 * Typed reads of the environment. An invalid value adds a warning and yields the fallback; each
 * variable is parsed (and warned about) once however many signals read it.
 */
class EnvReader {
  readonly warnings: string[] = [];
  private readonly memo = new Map<string, unknown>();

  constructor(private readonly env: Env) {}

  /** The spec treats an empty value as unset. */
  raw(name: string): string | undefined {
    const v = this.env[name]?.trim();
    return v === undefined || v === '' ? undefined : v;
  }

  private once<T>(name: string, parse: () => T): T {
    if (!this.memo.has(name)) this.memo.set(name, parse());
    return this.memo.get(name) as T;
  }

  /** `undefined` when unset or invalid (warned), so a caller can fall back to another variable. */
  private checked<T>(name: string, parse: (v: string) => T | undefined, problem: string) {
    return this.once(name, () => {
      const v = this.raw(name);
      if (v === undefined) return undefined;
      const parsed = parse(v);
      if (parsed === undefined) this.warnings.push(`${name}=${v} ${problem}`);
      return parsed;
    });
  }

  oneOf<const T extends string>(name: string, list: readonly T[]): T | undefined {
    return this.checked(
      name,
      (v) => {
        const lower = v.toLowerCase();
        return isOneOf(list, lower) ? lower : undefined;
      },
      `is not one of ${list.join(', ')}`,
    );
  }

  bool(name: string): boolean | undefined {
    return this.checked(
      name,
      (v) => {
        const lower = v.toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
        if (['0', 'false', 'no', 'off'].includes(lower)) return false;
        return undefined;
      },
      'is not a boolean',
    );
  }

  positiveInt(name: string): number | undefined {
    return this.checked(
      name,
      (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : undefined;
      },
      'is not a positive integer (milliseconds)',
    );
  }

  httpUrl(name: string): string | undefined {
    return this.checked(
      name,
      (v) => {
        try {
          const u = new URL(v);
          return u.protocol === 'http:' || u.protocol === 'https:' ? v : undefined;
        } catch {
          return undefined;
        }
      },
      'is not an http(s) URL; ignored',
    );
  }

  keyValues(name: string): Record<string, string> {
    return this.once(name, () => parseKeyValueList(this.raw(name), name, this.warnings));
  }

  /** `OTEL_EXPORTER_OTLP_<SIGNAL>_<KEY>`, else `OTEL_EXPORTER_OTLP_<KEY>`. */
  perSignal<T>(
    signal: OtelSignal,
    key: string,
    read: (name: string) => T | undefined,
  ): T | undefined {
    return (
      read(`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${key}`) ?? read(`OTEL_EXPORTER_OTLP_${key}`)
    );
  }
}

function otlpFor(
  env: EnvReader,
  signal: OtelSignal,
  explicit: boolean,
): OtlpExporterConfig | undefined {
  const protocol =
    env.perSignal(signal, 'PROTOCOL', (n) => env.oneOf(n, OTLP_PROTOCOLS)) ?? 'http/protobuf';
  const signalUrl = env.httpUrl(`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`);
  const genericUrl = env.httpUrl('OTEL_EXPORTER_OTLP_ENDPOINT');
  let url: string;
  if (signalUrl !== undefined) url = signalUrl;
  else if (genericUrl !== undefined)
    url = protocol === 'grpc' ? genericUrl : `${genericUrl.replace(/\/+$/, '')}/v1/${signal}`;
  else if (explicit)
    url = protocol === 'grpc' ? 'http://localhost:4317' : `http://localhost:4318/v1/${signal}`;
  else return undefined;
  return {
    url,
    protocol,
    headers: {
      ...env.keyValues('OTEL_EXPORTER_OTLP_HEADERS'),
      ...env.keyValues(`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`),
    },
    timeoutMillis:
      env.perSignal(signal, 'TIMEOUT', (n) => env.positiveInt(n)) ?? DEFAULT_TIMEOUT_MS,
    compression:
      env.perSignal(signal, 'COMPRESSION', (n) => env.oneOf(n, OTLP_COMPRESSIONS)) ?? 'none',
  };
}

function hasEndpoint(env: EnvReader, signal: OtelSignal): boolean {
  return (
    env.raw('OTEL_EXPORTER_OTLP_ENDPOINT') !== undefined ||
    env.raw(`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`) !== undefined
  );
}

function exportersFor(
  env: EnvReader,
  signal: OtelSignal,
): { exporters: PushExporter[]; explicitOtlp: boolean; prometheus: boolean } {
  const name = `OTEL_${signal.toUpperCase()}_EXPORTER`;
  const raw = env.raw(name);
  if (raw === undefined) {
    return {
      exporters: hasEndpoint(env, signal) ? ['otlp'] : [],
      explicitOtlp: false,
      prometheus: false,
    };
  }
  const allowed =
    signal === 'metrics' ? ['otlp', 'console', 'none', 'prometheus'] : ['otlp', 'console', 'none'];
  const items = raw.split(',').map((s) => s.trim().toLowerCase());
  const exporters = new Set<PushExporter>();
  let prometheus = false;
  for (const item of items) {
    if (item === '') continue;
    if (!allowed.includes(item)) {
      env.warnings.push(
        `${name}: unknown exporter ${item} ignored (supported: ${allowed.join(', ')})`,
      );
      continue;
    }
    if (item === 'prometheus') prometheus = true;
    else if (item === 'otlp' || item === 'console') exporters.add(item);
  }
  // `none` anywhere in the list wins, per spec.
  const none = items.includes('none');
  return {
    exporters: none ? [] : [...exporters],
    explicitOtlp: !none && exporters.has('otlp'),
    prometheus: !none && prometheus,
  };
}

function signalConfig(env: EnvReader, signal: OtelSignal): SignalConfig & { prometheus: boolean } {
  const chosen = exportersFor(env, signal);
  const otlp = chosen.exporters.includes('otlp')
    ? otlpFor(env, signal, chosen.explicitOtlp)
    : undefined;
  return {
    exporters: otlp ? chosen.exporters : chosen.exporters.filter((e) => e !== 'otlp'),
    otlp,
    prometheus: chosen.prometheus,
  };
}

function samplerOf(env: EnvReader): { sampler: SamplerName; ratio: number } {
  const sampler = env.oneOf('OTEL_TRACES_SAMPLER', SAMPLERS) ?? 'parentbased_always_on';
  let ratio = 1;
  const arg = env.raw('OTEL_TRACES_SAMPLER_ARG');
  if (arg !== undefined && sampler.endsWith('traceidratio')) {
    const n = Number(arg);
    if (Number.isFinite(n) && n >= 0 && n <= 1) ratio = n;
    else
      env.warnings.push(`OTEL_TRACES_SAMPLER_ARG=${arg} is not a ratio between 0 and 1; using 1`);
  }
  return { sampler, ratio };
}

/**
 * An invalid value is never fatal: it adds a warning and the default applies. Unlike the spec,
 * with no OTLP endpoint and no explicit `OTEL_<SIGNAL>_EXPORTER=otlp` a signal does not export
 * over OTLP, so an installation without a collector does not retry `localhost:4318` forever.
 */
export function parseOtelConfig(vars: Env): OtelConfig {
  const env = new EnvReader(vars);
  const disabled = env.bool('OTEL_SDK_DISABLED') ?? false;
  const resourceAttributes = { ...env.keyValues('OTEL_RESOURCE_ATTRIBUTES') };
  const serviceName =
    env.raw('OTEL_SERVICE_NAME') ?? resourceAttributes['service.name'] ?? 'switchboard';
  delete resourceAttributes['service.name'];

  const traces = signalConfig(env, 'traces');
  const metrics = signalConfig(env, 'metrics');
  const logs = signalConfig(env, 'logs');
  const { sampler, ratio } = samplerOf(env);
  return {
    disabled,
    serviceName,
    resourceAttributes,
    traces: { exporters: traces.exporters, otlp: traces.otlp, sampler, samplerRatio: ratio },
    metrics: {
      exporters: metrics.exporters,
      otlp: metrics.otlp,
      prometheus: !disabled && ((env.bool('SWITCHBOARD_PROMETHEUS') ?? true) || metrics.prometheus),
      exportIntervalMillis:
        env.positiveInt('OTEL_METRIC_EXPORT_INTERVAL') ?? DEFAULT_METRIC_INTERVAL_MS,
      exportTimeoutMillis:
        env.positiveInt('OTEL_METRIC_EXPORT_TIMEOUT') ?? DEFAULT_METRIC_TIMEOUT_MS,
    },
    logs: { exporters: logs.exporters, otlp: logs.otlp },
    diagLevel: env.oneOf('OTEL_LOG_LEVEL', DIAG_LEVELS) ?? 'warn',
    warnings: env.warnings,
  };
}

export function exportsSignal(config: OtelConfig, signal: OtelSignal): boolean {
  return !config.disabled && config[signal].exporters.length > 0;
}

export interface SignalStatus {
  signal: OtelSignal;
  exporters: PushExporter[];
  protocol: OtlpProtocol | null;
  /** `scheme://host[:port]` only. */
  endpoint: string | null;
  /** A count: names and values are not shown. */
  headers: number;
}

/** Never headers or URL credentials. */
export interface TelemetryStatus {
  enabled: boolean;
  serviceName: string;
  prometheus: boolean;
  signals: SignalStatus[];
  sampler: string;
}

export function telemetryStatus(config: OtelConfig): TelemetryStatus {
  return {
    enabled: !config.disabled,
    serviceName: config.serviceName,
    prometheus: config.metrics.prometheus,
    signals: OTEL_SIGNALS.map((s) => {
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
