import { context } from '@opentelemetry/api';
import { logs, SeverityNumber, type AnyValue, type LogAttributes } from '@opentelemetry/api-logs';

/**
 * pino → OpenTelemetry logs. A pino destination stream: it receives each line after pino has
 * serialised and redacted it, and emits it as an OTel log record through the global
 * LoggerProvider (registered in `telemetry/setup.ts`; a no-op until then). pino writes to its
 * streams synchronously, so the active context is the one of the log call and the record carries
 * its trace and span ids.
 */

const SEVERITY: Record<string, { number: SeverityNumber; text: string }> = {
  trace: { number: SeverityNumber.TRACE, text: 'TRACE' },
  debug: { number: SeverityNumber.DEBUG, text: 'DEBUG' },
  info: { number: SeverityNumber.INFO, text: 'INFO' },
  warn: { number: SeverityNumber.WARN, text: 'WARN' },
  error: { number: SeverityNumber.ERROR, text: 'ERROR' },
  fatal: { number: SeverityNumber.FATAL, text: 'FATAL' },
};
const NUMERIC_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/** Fields that become the record's own parts, or are on the resource already. */
const RESERVED = new Set(['level', 'time', 'msg', 'service', 'trace_id', 'span_id', 'trace_flags']);

/** Records from the OTel SDK's own diagnostics are not exported, so a failing exporter cannot loop. */
export const OTEL_DIAG_COMPONENT = 'otel';

/**
 * A line logged with `{ [LOCAL_ONLY]: true }` stays on stdout and is never exported (the one-time
 * bootstrap password).
 */
export const LOCAL_ONLY = 'local_only';

function toAnyValue(value: unknown): AnyValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map(toAnyValue);
  if (typeof value === 'object') {
    const out: Record<string, AnyValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toAnyValue(v);
    return out;
  }
  return typeof value === 'bigint' ? value.toString() : null;
}

/** One pino JSON line as an OTel log record's parts. Exported for tests. */
export function toLogRecord(line: Record<string, unknown>): {
  timestamp: Date | undefined;
  severityNumber: SeverityNumber;
  severityText: string;
  body: string;
  attributes: LogAttributes;
} {
  const levelKey =
    typeof line.level === 'number' ? (NUMERIC_LEVELS[line.level] ?? 'info') : String(line.level);
  const severity = SEVERITY[levelKey] ?? { number: SeverityNumber.UNSPECIFIED, text: levelKey };
  const attributes: LogAttributes = {};
  for (const [k, v] of Object.entries(line)) {
    if (RESERVED.has(k) || v === undefined) continue;
    if (k === 'err' && v !== null && typeof v === 'object') {
      // pino's error serializer: { type, message, stack }; the OTel exception attributes.
      const e = v as { type?: unknown; message?: unknown; stack?: unknown };
      if (typeof e.type === 'string') attributes['exception.type'] = e.type;
      if (typeof e.message === 'string') attributes['exception.message'] = e.message;
      if (typeof e.stack === 'string') attributes['exception.stacktrace'] = e.stack;
      continue;
    }
    attributes[k] = toAnyValue(v);
  }
  const time = line.time;
  const timestamp =
    typeof time === 'string' || typeof time === 'number' ? new Date(time) : undefined;
  return {
    timestamp: timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : undefined,
    severityNumber: severity.number,
    severityText: severity.text,
    body: typeof line.msg === 'string' ? line.msg : '',
    attributes,
  };
}

/** A pino destination (`{ write }`) that emits every line as an OTel log record. */
export function createOtelLogStream(scope = 'switchboard'): { write(line: string): void } {
  return {
    write(line: string) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== 'object') return;
      const obj = parsed as Record<string, unknown>;
      if (obj.component === OTEL_DIAG_COMPONENT || obj[LOCAL_ONLY] === true) return;
      const record = toLogRecord(obj);
      logs.getLogger(scope).emit({
        ...(record.timestamp ? { timestamp: record.timestamp } : {}),
        severityNumber: record.severityNumber,
        severityText: record.severityText,
        body: record.body,
        attributes: record.attributes,
        context: context.active(),
      });
    },
  };
}
