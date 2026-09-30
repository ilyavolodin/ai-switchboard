import type { FastifyInstance } from 'fastify';

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
import type { InstanceKind, Role } from '../../domain/status.js';
import {
  createInstance,
  deleteInstance,
  requestInstanceReload,
  setInstanceEnabled,
  updateInstance,
  type InstanceDraft,
  type InstancePatch,
} from '../../services/instances.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import { instanceDetail, instanceSummaries } from '../read/instances.js';
import { allow, instanceDeps } from './options.js';

/** The body fields each kind's create and update take; the service does the rest. */
export interface LifecycleSpec<Create, Update> {
  kind: InstanceKind;
  base: string;
  role: Role;
  list: () => Promise<unknown>;
  view: (id: string) => Promise<unknown>;
  create: { body: object; draft: (body: Create) => InstanceDraft };
  update: { body: object; patch: (body: Update) => InstancePatch };
}

/**
 * `GET`, `POST`, `PUT :id`, `POST :id/enable`, `POST :id/reload` and `DELETE :id`, the same for
 * every instance kind. The services rebuild what a change affects.
 */
export function registerInstanceLifecycle<Create extends Reasoned, Update extends Reasoned>(
  app: FastifyInstance,
  ctx: ApiContext,
  spec: LifecycleSpec<Create, Update>,
): void {
  const { kind, base, role } = spec;

  app.get(base, allow('viewer'), async () => spec.list());

  app.post<{ Body: Create }>(base, allow(role, spec.create.body), async (req, reply) => {
    const meta = changeMeta(req, ctx.clock);
    // Fastify validated the body against `spec.create.body`.
    const draft = spec.create.draft(req.body as Create);
    const row = await createInstance(instanceDeps(ctx), kind, draft, meta);
    return reply.code(201).send(await spec.view(row.id));
  });

  app.put<{ Params: { id: string }; Body: Update }>(
    `${base}/:id`,
    allow(role, spec.update.body),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      const { after } = await updateInstance(
        instanceDeps(ctx),
        kind,
        req.params.id,
        spec.update.patch(req.body as Update),
        meta,
      );
      return spec.view(after.id);
    },
  );

  app.post<{ Params: { id: string }; Body: EnableRequest }>(
    `${base}/:id/enable`,
    allow(role, enableBody),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      const row = await setInstanceEnabled(
        instanceDeps(ctx),
        kind,
        req.params.id,
        req.body.enabled,
        meta,
      );
      return spec.view(row.id);
    },
  );

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    `${base}/:id/reload`,
    allow(role, reasonedBody),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      const row = await requestInstanceReload(instanceDeps(ctx), kind, req.params.id, meta);
      return spec.view(row.id);
    },
  );

  app.delete<{ Params: { id: string }; Body: Reasoned }>(
    `${base}/:id`,
    allow(role),
    async (req, reply) => {
      await deleteInstance(instanceDeps(ctx), kind, req.params.id, changeMeta(req, ctx.clock));
      return reply.code(204).send();
    },
  );
}

/** Notifiers and secret providers: admin only, settings without caps. */
export function registerAdminInstanceRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
  kind: 'notifier' | 'secret_provider',
  base: string,
): void {
  registerInstanceLifecycle<CreateInstanceRequest, UpdateInstanceRequest>(app, ctx, {
    kind,
    base,
    role: 'admin',
    list: () => instanceSummaries(ctx, kind),
    view: (id) => instanceDetail(ctx, kind, id),
    create: {
      body: createInstanceBody,
      draft: ({ typeId, name, settings, enabled }) => ({ typeId, name, settings, enabled }),
    },
    update: {
      body: updateInstanceBody,
      patch: ({ name, settings }) => ({ name, settings }),
    },
  });
}
