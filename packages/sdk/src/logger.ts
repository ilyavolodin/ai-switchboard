export type LogFields = Record<string, unknown>;

/** Structured logger handed to plugins. The core backs it with its own JSON logger. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

export interface MemoryLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

/** A logger that records entries in memory; useful in tests. */
export function createMemoryLogger(
  entries: MemoryLogEntry[] = [],
  base: LogFields = {},
): Logger & { entries: MemoryLogEntry[] } {
  const log =
    (level: MemoryLogEntry['level']) =>
    (message: string, fields: LogFields = {}): void => {
      entries.push({ level, message, fields: { ...base, ...fields } });
    };
  return {
    entries,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (fields) => createMemoryLogger(entries, { ...base, ...fields }),
  };
}
