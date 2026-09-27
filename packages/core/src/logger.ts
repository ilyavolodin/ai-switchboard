import type { Logger, LogFields } from '@ai-switchboard/sdk';
import { pino, type Logger as PinoLogger } from 'pino';

export type CoreLogger = PinoLogger;

export function createLogger(options: { level?: string; pretty?: boolean } = {}): CoreLogger {
  return pino({
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: 'switchboard' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
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
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

/** Adapt the core's pino logger to the SDK's `Logger` handed to plugins. */
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

/** A silent logger for tests. */
export function silentLogger(): CoreLogger {
  return pino({ level: 'silent' });
}
