import type { FastifyInstance } from 'fastify';

import type { InstanceKind, Role } from '../../domain/status.js';
import {
  createInstance,
  deleteInstance,
  requestInstanceReload,
  setInstanceEnabled,
  updateInstance,
  type InstanceHead,
} from '../../services/instances.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import {
  createInstanceBody,
  enableBody,
  reasonedBody,
  updateInstanceBody,
  type CreateInstanceRequest,
  type EnableRequest,
  type Reasoned,
  type UpdateInstanceRequest,
} from '../../contract/index.js';
import { instanceDetail, instanceSummaries } from '../read/instances.js';
import { allow, instanceDeps } from './options.js';

export interface LifecycleSpec {
  kind: InstanceKind;
  base: string;
  role: Role;
  view: (id: string) => Promise<unknown>;
  /** After this replica rebuilt the instance (a secret provider rebuilds what uses it). */
  afterRebuild?: (row: InstanceHead) => Promise<void>;
}

/** `POST :id/enable`, `POST :id/reload` and `DELETE :id`, the same for every instance kind. */
export function registerInstanceLifecycle(
  app: FastifyInstance,
  ctx: ApiContext,
  spec: LifecycleSpec,
): void {
  const { kind, base } = spec;

  app.post<{ Params: { id: string }; Body: EnableRequest }>(
    `${base}/:id/enable`,
    allow(spec.role, enableBody),
    async (req) => {
      const row = await setInstanceEnabled(
        ctx.db,
        kind,
        req.params.id,
        req.body.enabled,
        changeMeta(req, ctx.clock),
      );
      await ctx.runtime.reload(kind, row.id);
      await spec.afterRebuild?.(row);
      return spec.view(row.id);
    },
  );

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    `${base}/:id/reload`,
    allow(spec.role, reasonedBody),
    async (req) => {
      const row = await requestInstanceReload(
        ctx.db,
        kind,
        req.params.id,
        changeMeta(req, ctx.clock),
      );
      await ctx.runtime.reload(kind, row.id);
      await spec.afterRebuild?.(row);
      return spec.view(row.id);
    },
  );

  app.delete<{ Params: { id: string }; Body: Reasoned }>(
    `${base}/:id`,
    allow(spec.role),
    async (req, reply) => {
      const row = await deleteInstance(ctx.db, kind, req.params.id, changeMeta(req, ctx.clock));
      await ctx.runtime.reload(kind, row.id);
      return reply.code(204).send();
    },
  );
}

/**
 * Notifiers and secret providers: admin only. A secret provider's instances resolve their
 * secrets when built, so a change to one rebuilds the instances that reference it.
 */
export function registerAdminInstanceRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
  kind: 'notifier' | 'secret_provider',
  base: string,
): void {
  const view = (id: string) => instanceDetail(ctx, kind, id);
  const rebuildDependents = async (names: string[]) => {
    if (kind === 'secret_provider') await ctx.host.reloadDependentsOf([...new Set(names)]);
  };

  registerInstanceLifecycle(app, ctx, {
    kind,
    base,
    role: 'admin',
    view,
    afterRebuild: (row) => rebuildDependents([row.name]),
  });

  app.get(base, allow('viewer'), async () => instanceSummaries(ctx, kind));

  app.post<{ Body: CreateInstanceRequest }>(
    base,
    allow('admin', createInstanceBody),
    async (req, reply) => {
      const meta = changeMeta(req, ctx.clock);
      const { typeId, name, settings, enabled } = req.body;
      const row = await createInstance(
        instanceDeps(ctx),
        kind,
        { typeId, name, settings, enabled },
        meta,
      );
      await ctx.runtime.reload(kind, row.id);
      // References to this name that failed before the provider existed resolve now.
      await rebuildDependents([row.name]);
      return reply.code(201).send(await view(row.id));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateInstanceRequest }>(
    `${base}/:id`,
    allow('admin', updateInstanceBody),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      const { name, settings } = req.body;
      const { before, after } = await updateInstance(
        instanceDeps(ctx),
        kind,
        req.params.id,
        { name, settings },
        meta,
      );
      await ctx.runtime.reload(kind, after.id);
      // After a rename, instances still naming the old provider fail with a secret_error;
      // nothing rewrites their references.
      await rebuildDependents([before.name, after.name]);
      return view(after.id);
    },
  );
}
