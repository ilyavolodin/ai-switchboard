import { isInvokeError, isTransportError } from '@ai-switchboard/sdk';

import type { InstanceKind } from '../domain/status.js';
import type { Telemetry } from '../telemetry/telemetry.js';

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

/**
 * Attributes unexpected exceptions to the plugin before they propagate and, with `spans`, gives
 * each call a child span. Sync methods stay sync.
 */
export function attribute<T extends object>(
  target: T,
  onError: (err: unknown, method: string) => void,
  spans?: CallSpan,
): T {
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
      return (...args: unknown[]) => {
        try {
          const out = call(args);
          if (out instanceof Promise) {
            return out.catch((err: unknown) => {
              if (!isExpectedError(err)) onError(err, method);
              throw err;
            });
          }
          return out;
        } catch (err) {
          if (!isExpectedError(err)) onError(err, method);
          throw err;
        }
      };
    },
  });
}
