import type { Logger, LogFields } from '@ai-switchboard/sdk';
import { context, trace } from '@opentelemetry/api';
import {
  destination,
  multistream,
  pino,
  transport,
  type DestinationStream,
  type Logger as PinoLogger,
} from 'pino';

import { createOtelLogStream } from './telemetry/log-bridge.js';
import { exportsSignal, type OtelConfig } from './telemetry/otel-config.js';

export type CoreLogger = PinoLogger;

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  /** Also emit every line as an OpenTelemetry log record. */
  exportLogs?: boolean;
  destination?: DestinationStream;
}

function traceMixin(): Record<string, string> {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const sc = span.spanContext();
  if (!trace.isSpanContextValid(sc)) return {};
  return { trace_id: sc.traceId, span_id: sc.spanId };
}

export function createLogger(options: LoggerOptions = {}): CoreLogger {
  const config = {
    level: options.level ?? 'info',
    base: { service: 'switchboard' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    mixin: traceMixin,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
        '*.secret',
      ],
      remove: true,
    },
  };
  if (!options.exportLogs) {
    if (options.destination) return pino(config, options.destination);
    return pino({
      ...config,
      ...(options.pretty
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    });
  }
  // stdout keeps the same JSON (or pretty) lines; the OTel stream gets the same redacted lines.
  const stdout: DestinationStream =
    options.destination ??
    (options.pretty
      ? transport({ target: 'pino-pretty', options: { colorize: true } })
      : destination(1));
  return pino(
    config,
    multistream([
      { level: 'trace', stream: stdout },
      { level: 'trace', stream: createOtelLogStream() },
    ]),
  );
}

export function loggerFor(config: {
  logLevel: string;
  prettyLogs: boolean;
  telemetry: OtelConfig;
}): CoreLogger {
  return createLogger({
    level: config.logLevel,
    pretty: config.prettyLogs,
    exportLogs: exportsSignal(config.telemetry, 'logs'),
  });
}

export function toPluginLogger(logger: CoreLogger): Logger {
  const wrap = (l: PinoLogger): Logger => ({
    debug: (message: string, fields?: LogFields) => l.debug(fields ?? {}, message),
    info: (message: string, fields?: LogFields) => l.info(fields ?? {}, message),
    warn: (message: string, fields?: LogFields) => l.warn(fields ?? {}, message),
    error: (message: string, fields?: LogFields) => l.error(fields ?? {}, message),
    child: (fields: LogFields) => wrap(l.child(fields)),
  });
  return wrap(logger);
}

export function silentLogger(): CoreLogger {
  return pino({ level: 'silent' });
}
