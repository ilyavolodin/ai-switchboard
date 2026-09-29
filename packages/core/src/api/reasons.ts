import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Clock } from '../clock.js';

/** What the audit log records for a change made without a reason while reasons are optional. */
export const NO_REASON = '(no reason given)';

export const REASON_POLICY_TTL_MS = 5_000;

/**
 * Cached in-process so a mutation does not read the settings row on every request. Other replicas
 * see a change within the TTL; that staleness is acceptable (at worst a change is refused, or
 * audited as "(no reason given)", just after an admin flipped the switch).
 */
export interface ReasonPolicy {
  required(): Promise<boolean>;
  invalidate(): void;
}

export function createReasonPolicy(
  load: () => Promise<boolean>,
  clock: Clock,
  ttlMs = REASON_POLICY_TTL_MS,
): ReasonPolicy {
  let cached: { value: boolean; until: number } | null = null;
  let generation = 0;
  return {
    async required() {
      const now = clock.now().getTime();
      if (cached && now < cached.until) return cached.value;
      const gen = generation;
      try {
        const value = await load();
        // An invalidation while loading means the value may already be stale: use it, don't keep it.
        if (gen === generation) cached = { value, until: now + ttlMs };
        return value;
      } catch {
        // Fail closed: when the setting cannot be read, a reason stays required.
        return true;
      }
    },
    invalidate() {
      generation += 1;
      cached = null;
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    reasons: ReasonPolicy;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Whether the route reads a `reason` from its body (a schema naming it, or a bodiless DELETE). */
function takesReason(req: FastifyRequest): boolean {
  const body = req.routeOptions.schema?.body as
    { properties?: Record<string, unknown> } | undefined;
  if (body?.properties) return 'reason' in body.properties;
  return req.method === 'DELETE';
}

/**
 * When reasons are optional, fill a missing or blank `reason` before the route validates its body,
 * so every route's `requireReason` and audit write stay unchanged.
 */
export function registerReasonPolicy(app: FastifyInstance, policy: ReasonPolicy): void {
  app.decorate('reasons', policy);
  app.addHook('preValidation', async (req) => {
    if (!MUTATING.has(req.method)) return;
    if (!req.url.startsWith('/api/v1/') || req.url.startsWith('/api/v1/auth/')) return;
    if (!takesReason(req)) return;
    const body: unknown = req.body;
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body)))
      return;
    const current = (body as { reason?: unknown } | null | undefined)?.reason;
    if (typeof current === 'string' && current.trim() !== '') return;
    if (await policy.required()) return;
    req.body = { ...(body ?? {}), reason: NO_REASON };
  });
}
