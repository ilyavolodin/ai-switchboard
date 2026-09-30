import { isInvokeError, isTransportError } from '@ai-switchboard/sdk';

import type { InstanceKind } from '../domain/status.js';
import type { Telemetry } from '../telemetry/telemetry.js';
import { withTimeout } from '../util/timeout.js';

/** Every plugin call that returns a promise, unless the method has its own limit below. */
export const PLUGIN_CALL_TIMEOUT_MS = 45_000;

export const HEALTH_TIMEOUT_MS = 10_000;

/** `invoke` has its own per-destination limit and must never be cut short here (idempotency). */
const METHOD_TIMEOUTS: Readonly<Record<string, number | null>> = {
  invoke: null,
  health: HEALTH_TIMEOUT_MS,
};

/** Milliseconds a plugin method may take; undefined means no limit here. */
export function callTimeoutMs(method: string): number | undefined {
  const own = METHOD_TIMEOUTS[method];
  if (own === null) return undefined;
  return own ?? PLUGIN_CALL_TIMEOUT_MS;
}

/** Errors a plugin raises on purpose to describe a backend outcome; not counted as plugin bugs. */
export function isExpectedError(err: unknown): boolean {
  return isTransportError(err) || isInvokeError(err);
}

export interface CallSpan {
  telemetry: Pick<Telemetry, 'childSpan'>;
  kind: InstanceKind;
  plugin: string;
  instanceId: string;
}

export interface AttributeOptions {
  /** Gives each call a child span. */
  spans?: CallSpan;
  /** Replaces `callTimeoutMs` (tests). */
  timeoutFor?: (method: string) => number | undefined;
}

/**
 * The one wrapper every plugin call goes through: unexpected exceptions and timeouts are
 * attributed to the plugin before they propagate, and each call may get a child span. A method
 * that returns a promise is cut off after its limit (the work keeps running and its result is
 * ignored). Sync methods stay sync.
 */
export function attribute<T extends object>(
  target: T,
  onError: (err: unknown, method: string) => void,
  options: AttributeOptions = {},
): T {
  const { spans, timeoutFor = callTimeoutMs } = options;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      const method = String(prop);
      const call = (args: unknown[]): unknown =>
        spans
          ? spans.telemetry.childSpan(
              `switchboard.plugin.${method}`,
              {
                plugin: spans.plugin,
                'switchboard.plugin.kind': spans.kind,
                'switchboard.plugin.method': method,
                instance_id: spans.instanceId,
              },
              () => fn.apply(obj, args),
            )
          : fn.apply(obj, args);
      const failed = (err: unknown): never => {
        if (!isExpectedError(err)) onError(err, method);
        throw err;
      };
      return (...args: unknown[]) => {
        let out: unknown;
        try {
          out = call(args);
        } catch (err) {
          return failed(err);
        }
        if (!(out instanceof Promise)) return out;
        const ms = timeoutFor(method);
        const limited = ms === undefined ? out : withTimeout(out, ms, `timed out after ${ms} ms`);
        return limited.catch(failed);
      };
    },
  });
}
