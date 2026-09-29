import jsonata from 'jsonata';

import type { ArtifactRef } from '@ai-switchboard/sdk';

import { errorText } from '../util/errors.js';
import { withTimeout } from '../util/timeout.js';

import type { SwitchboardFunctionName } from './context-descriptors.js';
import {
  SECRET_MARKER_KEY,
  neutralizeSecretMarkers,
  secretRefString,
  type SecretRefMarker,
} from './secret-markers.js';

export const DEFAULT_TIMEOUT_MS = 2000;
export const DEFAULT_MAX_RESOLVE_CALLS = 10;
export const ENV_PREFIX = 'SWITCHBOARD_VAR_';

export type ExprErrorCode = 'syntax' | 'timeout' | 'resolve_limit' | 'runtime';

export type EvalResult =
  { ok: true; value: unknown } | { ok: false; error: string; code: ExprErrorCode };

/** Missing lookups make `$resolve`/`$linked` an error. */
export interface EvalFunctions {
  /** Resolves `null` when the artifact is gone. */
  resolve?: (ref: ArtifactRef) => Promise<unknown>;
  linked?: (ref: ArtifactRef) => Promise<ArtifactRef[]>;
  now: Date;
}

export interface ExpressionEngineOptions {
  timeoutMs?: number;
  maxResolveCalls?: number;
  /** Only keys starting with `SWITCHBOARD_VAR_` are kept. */
  env?: Record<string, string | undefined>;
  cacheSize?: number;
}

export interface ExpressionEngine {
  check(expr: string): { ok: true } | { ok: false; error: string };
  /** Evaluate against `context`. Never throws. */
  evaluate(expr: string, context: unknown, fns: EvalFunctions): Promise<EvalResult>;
}

class ExprLimitError extends Error {
  override readonly name = 'ExprLimitError';
  constructor(
    message: string,
    readonly code: ExprErrorCode,
  ) {
    super(message);
  }
}

interface JsonataFailure {
  message?: unknown;
  code?: unknown;
  position?: unknown;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === 'object') {
    const e = err as JsonataFailure;
    const message = typeof e.message === 'string' ? e.message : 'expression failed';
    const code = typeof e.code === 'string' ? ` (${e.code})` : '';
    const position = typeof e.position === 'number' ? ` at ${e.position}` : '';
    return `${message}${code}${position}`;
  }
  return String(err);
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === 'string' && typeof v.id === 'string';
}

/** JSONata output (sequences, frozen arrays, functions) as plain JSON. */
export function toPlain(value: unknown): unknown {
  if (value === undefined || typeof value === 'function') return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function filterEnv(env: Record<string, string | undefined>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(ENV_PREFIX) && v !== undefined) out.set(k, v);
  }
  return out;
}

export function createExpressionEngine(options: ExpressionEngineOptions = {}): ExpressionEngine {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResolve = options.maxResolveCalls ?? DEFAULT_MAX_RESOLVE_CALLS;
  const cacheSize = options.cacheSize ?? 500;
  const env = filterEnv(options.env ?? {});
  const cache = new Map<string, jsonata.Expression>();

  function compile(expr: string): jsonata.Expression {
    const hit = cache.get(expr);
    if (hit) {
      cache.delete(expr);
      cache.set(expr, hit);
      return hit;
    }
    const compiled = jsonata(expr, { timeout: timeoutMs, stack: 500, sequence: 100_000 });
    cache.set(expr, compiled);
    if (cache.size > cacheSize) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
    return compiled;
  }

  return {
    check(expr) {
      try {
        compile(expr);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: describeError(err) };
      }
    },

    async evaluate(expr, context, fns) {
      let compiled: jsonata.Expression;
      try {
        compiled = compile(expr);
      } catch (err) {
        return { ok: false, error: describeError(err), code: 'syntax' };
      }

      let aborted = false;
      let lookups = 0;
      const guard = (name: string): void => {
        if (aborted) throw new ExprLimitError(`evaluation exceeded ${timeoutMs} ms`, 'timeout');
        lookups++;
        if (lookups > maxResolve) {
          throw new ExprLimitError(
            `${name} called more than ${maxResolve} times in one evaluation`,
            'resolve_limit',
          );
        }
      };
      const nowIso = fns.now.toISOString();
      const bindings: Record<SwitchboardFunctionName, unknown> = {
        now: () => nowIso,
        millis: () => fns.now.getTime(),
        env: (name: unknown) => {
          if (typeof name !== 'string') return undefined;
          const key = name.startsWith(ENV_PREFIX) ? name : `${ENV_PREFIX}${name}`;
          return env.get(key);
        },
        secretRef: (name: unknown): SecretRefMarker => {
          if (typeof name !== 'string') {
            throw new ExprLimitError('$secretRef expects a string name', 'runtime');
          }
          return { [SECRET_MARKER_KEY]: secretRefString(name) };
        },
        secret: () => {
          throw new ExprLimitError(
            '$secret is not available: expressions cannot read secret values; use $secretRef(name)',
            'runtime',
          );
        },
        eval: () => {
          throw new ExprLimitError('$eval is not available in Switchboard expressions', 'runtime');
        },
        resolve: async (ref: unknown) => {
          guard('$resolve');
          if (!isArtifactRef(ref)) {
            throw new ExprLimitError(
              '$resolve expects an artifact reference {kind, id}',
              'runtime',
            );
          }
          if (!fns.resolve) throw new ExprLimitError('$resolve is not available here', 'runtime');
          const value = await fns.resolve({ kind: ref.kind, id: ref.id, ...rest(ref) });
          if (aborted) throw new ExprLimitError(`evaluation exceeded ${timeoutMs} ms`, 'timeout');
          return neutralizeSecretMarkers(value) ?? undefined;
        },
        linked: async (ref: unknown) => {
          guard('$linked');
          if (!isArtifactRef(ref)) {
            throw new ExprLimitError('$linked expects an artifact reference {kind, id}', 'runtime');
          }
          if (!fns.linked) throw new ExprLimitError('$linked is not available here', 'runtime');
          const value = await fns.linked({ kind: ref.kind, id: ref.id, ...rest(ref) });
          if (aborted) throw new ExprLimitError(`evaluation exceeded ${timeoutMs} ms`, 'timeout');
          return neutralizeSecretMarkers(value);
        },
      };

      const run = (async (): Promise<EvalResult> => {
        try {
          const value: unknown = await compiled.evaluate(
            neutralizeSecretMarkers(context),
            bindings,
          );
          return { ok: true, value: toPlain(value) };
        } catch (err) {
          if (err instanceof ExprLimitError)
            return { ok: false, error: err.message, code: err.code };
          const code =
            err !== null && typeof err === 'object' && (err as JsonataFailure).code === 'D1012'
              ? 'timeout'
              : 'runtime';
          return { ok: false, error: describeError(err), code };
        }
      })();
      try {
        return await withTimeout(run, timeoutMs, `evaluation exceeded ${timeoutMs} ms`);
      } catch (err) {
        // Only the timeout rejects: `run` turns every failure into a result.
        return { ok: false, error: errorText(err), code: 'timeout' };
      } finally {
        // JSONata's own guardrail stops pure loops at the next step; `aborted` stops lookups.
        aborted = true;
      }
    },
  };
}

function rest(ref: ArtifactRef): Partial<ArtifactRef> {
  const out: Partial<ArtifactRef> = {};
  if (typeof ref.url === 'string') out.url = ref.url;
  if (typeof ref.version === 'string') out.version = ref.version;
  return out;
}
