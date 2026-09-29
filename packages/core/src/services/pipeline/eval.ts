import type { ArtifactRef, Event } from '@ai-switchboard/sdk';

import type { Deps } from '../../deps.js';
import {
  createExpressionEngine,
  type EvalFunctions,
  type ExpressionEngine,
} from '../../expr/index.js';

/** `env` holds non-secret values for `$env`; without it, `process.env` filtered by prefix. */
export function expressionEngine(deps: {
  env?: Record<string, string | undefined>;
}): ExpressionEngine {
  return createExpressionEngine({ env: deps.env ?? process.env });
}

function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * A reference resolves through the source of the event it belongs to, else the first event's
 * source, else the first of `fallbackSources` that can resolve.
 */
export function evalFunctions(
  ctx: Pick<Deps, 'runtime'>,
  events: readonly Event[],
  now: Date,
  fallbackSources: readonly string[] = [],
): EvalFunctions {
  const sourceFor = (ref: ArtifactRef, method: 'resolve' | 'linked') => {
    const candidates = [
      ...events.filter((e) => sameArtifact(e.artifact, ref)).map((e) => e.sourceId),
      ...events.map((e) => e.sourceId),
      ...fallbackSources,
    ];
    for (const id of candidates) {
      const live = ctx.runtime.source(id);
      if (live?.source[method]) return live;
    }
    return undefined;
  };
  return {
    now,
    resolve: async (ref) => {
      const live = sourceFor(ref, 'resolve');
      if (!live?.source.resolve) throw new Error(`no source can resolve ${ref.kind}:${ref.id}`);
      return live.source.resolve(ref);
    },
    linked: async (ref) => {
      const live = sourceFor(ref, 'linked');
      if (!live?.source.linked) throw new Error(`no source can link ${ref.kind}:${ref.id}`);
      return live.source.linked(ref);
    },
  };
}
