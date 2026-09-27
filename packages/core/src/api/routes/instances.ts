import { secretPaths, validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { actorOf, requireRole } from '../../auth/fastify.js';
import { executors, notifiers, secretProviders, sources } from '../../db/schema.js';
import { instanceStatus } from '../../domain/labels.js';
import { literalSecretFields } from '../../secrets/refs.js';
import { recordAudit, recordAuditDiff } from '../../services/audit.js';
import type { ApiContext } from '../context.js';
import type {
  CreateExecutorRequest,
  CreateInstanceRequest,
  CreateSourceRequest,
  EnableRequest,
  InstanceSummary,
  UpdateExecutorRequest,
  UpdateInstanceRequest,
  UpdateSourceRequest,
} from '../contract.js';
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  requireReason,
  unprocessable,
} from '../errors.js';
import {
  executorDetail,
  executorSummaries,
  processesUsing,
  sourceDetail,
  sourceSummaries,
} from '../read/instances.js';
import { meterGauges } from '../read/meters.js';

const reasoned = {
  type: 'object',
  required: ['reason'],
  properties: { reason: { type: 'string' } },
} as const;

const sourceCapsSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    eventCapPerHour: { type: 'integer', minimum: 0 },
    eventCapPerDay: { type: 'integer', minimum: 0 },
    eventTypesEnabled: { type: 'array', items: { type: 'string' } },
    pollIntervalSeconds: { type: 'integer', minimum: 10, maximum: 86_400 },
    unauthenticated: { type: 'boolean' },
  },
};

const executorCapsSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runsPerHour: { type: 'integer', minimum: 0 },
    runsPerDay: { type: 'integer', minimum: 0 },
    usagePerDay: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
    meterPollSeconds: { type: 'integer', minimum: 30, maximum: 86_400 },
    meterStalenessMinutes: { type: 'integer', minimum: 1, maximum: 10_080 },
    estimatedLimits: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
  },
};

const relaxedCache = new WeakMap<JSONSchema, JSONSchema>();

/**
 * Stored settings hold `secret://` references in `x-secret` fields, so a secret field's
 * format/pattern cannot be checked here; the plugin's `create()` validates the resolved value.
 */
export function referenceTolerantSchema(schema: JSONSchema): JSONSchema {
  const cached = relaxedCache.get(schema);
  if (cached) return cached;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    if (obj['x-secret'] === true) {
      const relaxed: Record<string, unknown> = { type: 'string', 'x-secret': true };
      for (const k of [
        'title',
        'description',
        'x-group',
        'x-widget',
        'x-order',
        'x-help',
        'x-placeholder',
      ]) {
        if (k in obj) relaxed[k] = obj[k];
      }
      return relaxed;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
    return out;
  };
  const relaxed = walk(schema) as JSONSchema;
  relaxedCache.set(schema, relaxed);
  return relaxed;
}

/** Validate plugin settings against the type's schema; refuse literal values in secret fields. */
export function validateSettings(
  schema: JSONSchema,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const copy = structuredClone(settings);
  const check = validateAgainst(referenceTolerantSchema(schema), copy);
  if (!check.valid) throw badRequest('Settings do not match the plugin schema.', check.errors);
  const literals = literalSecretFields(secretPaths(schema), copy);
  if (literals.length > 0) {
    throw badRequest(
      'Secret fields must hold a secret:// reference, never a value.',
      literals.map((p) => `${p} must be a secret://<provider>/<name> reference`),
    );
  }
  return copy;
}

function validateCaps(schema: JSONSchema, caps: unknown): Record<string, unknown> {
  const copy = structuredClone(caps ?? {}) as Record<string, unknown>;
  const check = validateAgainst(schema, copy);
  if (!check.valid) throw badRequest('Caps are invalid.', check.errors);
  return copy;
}

function nonEmptyName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') throw badRequest('A name is required.');
  return name.trim().slice(0, 120);
}

export function registerInstanceRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, clock } = ctx;
  const viewer = { preHandler: requireRole('viewer') };
  const operator = { preHandler: requireRole('operator') };
  const admin = { preHandler: requireRole('admin') };

  // ------------------------------------------------------------------------------------------
  // Sources
  // ------------------------------------------------------------------------------------------

  /** A push instance without verify is refused unless explicitly marked unauthenticated. */
  const checkAuthentication = (id: string, typeId: string, unauthenticated: boolean): void => {
    const type = ctx.runtime.sourceType(typeId)?.type;
    if (!type) return;
    if (unauthenticated && type.allowsUnauthenticated !== true) {
      throw unprocessable(`${type.displayName} sources cannot run unauthenticated.`);
    }
    const live = ctx.runtime.source(id);
    if (
      type.mode !== 'pull' &&
      live &&
      typeof live.source.verify !== 'function' &&
      !unauthenticated
    ) {
      throw unprocessable(
        'This source would accept unauthenticated deliveries. Configure verification, or mark it "unauthenticated (evaluation)" explicitly.',
      );
    }
  };

  app.get('/api/v1/sources', viewer, async () => sourceSummaries(ctx));
  app.get<{ Params: { id: string } }>('/api/v1/sources/:id', viewer, async (req) =>
    sourceDetail(ctx, req.params.id),
  );

  app.post<{ Body: CreateSourceRequest }>(
    '/api/v1/sources',
    { ...operator, schema: { body: reasoned } },
    async (req, reply) => {
      const reason = requireReason(req.body);
      const typeEntry = ctx.runtime.sourceType(req.body.typeId);
      if (!typeEntry)
        throw unprocessable(`No installed plugin provides source type "${req.body.typeId}".`);
      const settings = validateSettings(typeEntry.type.settingsSchema, req.body.settings);
      const caps = validateCaps(sourceCapsSchema, req.body.caps);
      const name = nonEmptyName(req.body.name);
      const now = clock.now();
      const [row] = await db
        .insert(sources)
        .values({
          typeId: req.body.typeId,
          name,
          settings,
          caps,
          enabled: req.body.enabled ?? true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new HttpError(500, 'internal', 'insert failed');
      await ctx.host.reload('source', row.id);
      try {
        checkAuthentication(row.id, row.typeId, row.caps.unauthenticated === true);
      } catch (err) {
        await db.delete(sources).where(eq(sources.id, row.id));
        await ctx.host.reload('source', row.id);
        throw err;
      }
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'source',
        targetId: row.id,
        field: 'created',
        after: { name, typeId: row.typeId, settings, caps },
        reason,
        at: now,
      });
      return reply.code(201).send(await sourceDetail(ctx, row.id));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateSourceRequest }>(
    '/api/v1/sources/:id',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const [before] = await db.select().from(sources).where(eq(sources.id, req.params.id));
      if (!before) throw notFound('Source');
      const typeEntry = ctx.runtime.sourceType(before.typeId);
      const settings =
        req.body.settings && typeEntry
          ? validateSettings(typeEntry.type.settingsSchema, req.body.settings)
          : (req.body.settings ?? before.settings);
      const caps = req.body.caps ? validateCaps(sourceCapsSchema, req.body.caps) : before.caps;
      const name = req.body.name !== undefined ? nonEmptyName(req.body.name) : before.name;
      const now = clock.now();
      await db
        .update(sources)
        .set({ name, settings, caps, updatedAt: now })
        .where(eq(sources.id, before.id));
      await ctx.host.reload('source', before.id);
      try {
        checkAuthentication(
          before.id,
          before.typeId,
          (caps as { unauthenticated?: boolean }).unauthenticated === true,
        );
      } catch (err) {
        await db
          .update(sources)
          .set({ name: before.name, settings: before.settings, caps: before.caps })
          .where(eq(sources.id, before.id));
        await ctx.host.reload('source', before.id);
        throw err;
      }
      await recordAuditDiff(
        db,
        { actor: actorOf(req), scope: 'source', targetId: before.id, reason, at: now },
        {
          name: before.name,
          ...prefix('settings', before.settings),
          ...prefix('caps', before.caps),
        },
        { name, ...prefix('settings', settings), ...prefix('caps', caps) },
      );
      return sourceDetail(ctx, before.id);
    },
  );

  app.post<{ Params: { id: string }; Body: EnableRequest }>(
    '/api/v1/sources/:id/enable',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const [before] = await db.select().from(sources).where(eq(sources.id, req.params.id));
      if (!before) throw notFound('Source');
      const now = clock.now();
      await db
        .update(sources)
        .set({ enabled: req.body.enabled, updatedAt: now })
        .where(eq(sources.id, before.id));
      await ctx.host.reload('source', before.id);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'source',
        targetId: before.id,
        field: 'enabled',
        before: before.enabled,
        after: req.body.enabled,
        reason,
        at: now,
      });
      return sourceDetail(ctx, before.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/sources/:id/reload',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const [row] = await db
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.id, req.params.id));
      if (!row) throw notFound('Source');
      await ctx.host.reload('source', row.id);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'source',
        targetId: row.id,
        field: 'reload',
        reason,
        at: clock.now(),
      });
      return sourceDetail(ctx, row.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/sources/:id/provision',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const live = ctx.runtime.source(req.params.id);
      if (!live) throw notFound('Running source');
      if (typeof live.source.provision !== 'function')
        throw unprocessable(`${live.type.displayName} cannot register webhooks itself.`);
      const url = `${ctx.config.publicUrl}/hooks/${live.id}`;
      const result = await live.source.provision(url).catch((err: unknown) => ({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }));
      const now = clock.now();
      if (result.ok)
        await db.update(sources).set({ provisionedAt: now }).where(eq(sources.id, live.id));
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'source',
        targetId: live.id,
        field: 'provision',
        after: result,
        reason,
        at: now,
      });
      return {
        ok: result.ok,
        message:
          result.message ?? (result.ok ? `Webhook registered for ${url}` : 'Registration failed'),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string; type?: string } }>(
    '/api/v1/sources/:id/test-event',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      return ctx.pipeline.injectTestEvent(req.params.id, req.body.type, actorOf(req), reason);
    },
  );

  app.delete<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/sources/:id',
    operator,
    async (req, reply) => {
      const reason = requireReason(req.body);
      const [row] = await db.select().from(sources).where(eq(sources.id, req.params.id));
      if (!row) throw notFound('Source');
      const users = await processesUsing(ctx, row.id);
      if (users.length > 0)
        throw conflict(`Still used by ${users.join(', ')}. Remove it from those processes first.`);
      await db.delete(sources).where(eq(sources.id, row.id));
      await ctx.host.reload('source', row.id);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'source',
        targetId: row.id,
        field: 'deleted',
        before: { name: row.name, typeId: row.typeId },
        reason,
        at: clock.now(),
      });
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------------------------------------
  // Executors
  // ------------------------------------------------------------------------------------------

  app.get('/api/v1/executors', viewer, async () => executorSummaries(ctx));
  app.get<{ Params: { id: string } }>('/api/v1/executors/:id', viewer, async (req) =>
    executorDetail(ctx, req.params.id),
  );

  app.post<{ Body: CreateExecutorRequest }>(
    '/api/v1/executors',
    { ...operator, schema: { body: reasoned } },
    async (req, reply) => {
      const reason = requireReason(req.body);
      const typeEntry = ctx.runtime.executorType(req.body.typeId);
      if (!typeEntry)
        throw unprocessable(`No installed plugin provides executor type "${req.body.typeId}".`);
      const settings = validateSettings(typeEntry.type.settingsSchema, req.body.settings);
      const caps = validateCaps(executorCapsSchema, req.body.caps);
      const name = nonEmptyName(req.body.name);
      const now = clock.now();
      const [row] = await db
        .insert(executors)
        .values({
          typeId: req.body.typeId,
          name,
          settings,
          caps,
          targetDefaults: req.body.targetDefaults ?? {},
          enabled: req.body.enabled ?? true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new HttpError(500, 'internal', 'insert failed');
      await ctx.host.reload('executor', row.id);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'executor',
        targetId: row.id,
        field: 'created',
        after: { name, typeId: row.typeId, settings, caps },
        reason,
        at: now,
      });
      return reply.code(201).send(await executorDetail(ctx, row.id));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateExecutorRequest }>(
    '/api/v1/executors/:id',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const [before] = await db.select().from(executors).where(eq(executors.id, req.params.id));
      if (!before) throw notFound('Executor');
      const typeEntry = ctx.runtime.executorType(before.typeId);
      const settings =
        req.body.settings && typeEntry
          ? validateSettings(typeEntry.type.settingsSchema, req.body.settings)
          : (req.body.settings ?? before.settings);
      const caps = req.body.caps ? validateCaps(executorCapsSchema, req.body.caps) : before.caps;
      const name = req.body.name !== undefined ? nonEmptyName(req.body.name) : before.name;
      const targetDefaults = req.body.targetDefaults ?? before.targetDefaults;
      const now = clock.now();
      await db
        .update(executors)
        .set({ name, settings, caps, targetDefaults, updatedAt: now })
        .where(eq(executors.id, before.id));
      await ctx.host.reload('executor', before.id);
      await recordAuditDiff(
        db,
        { actor: actorOf(req), scope: 'executor', targetId: before.id, reason, at: now },
        {
          name: before.name,
          ...prefix('settings', before.settings),
          ...prefix('caps', before.caps),
          targetDefaults: before.targetDefaults,
        },
        { name, ...prefix('settings', settings), ...prefix('caps', caps), targetDefaults },
      );
      return executorDetail(ctx, before.id);
    },
  );

  app.post<{ Params: { id: string }; Body: EnableRequest }>(
    '/api/v1/executors/:id/enable',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const [before] = await db.select().from(executors).where(eq(executors.id, req.params.id));
      if (!before) throw notFound('Executor');
      const now = clock.now();
      await db
        .update(executors)
        .set({ enabled: req.body.enabled, updatedAt: now })
        .where(eq(executors.id, before.id));
      await ctx.host.reload('executor', before.id);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'executor',
        targetId: before.id,
        field: 'enabled',
        before: before.enabled,
        after: req.body.enabled,
        reason,
        at: now,
      });
      return executorDetail(ctx, before.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/executors/:id/reload',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const [row] = await db
        .select({ id: executors.id })
        .from(executors)
        .where(eq(executors.id, req.params.id));
      if (!row) throw notFound('Executor');
      // A reload clears an "unhealthy" mark set after 401/403; the next health check re-evaluates.
      await db.update(executors).set({ health: null }).where(eq(executors.id, row.id));
      await ctx.host.reload('executor', row.id);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'executor',
        targetId: row.id,
        field: 'reload',
        reason,
        at: clock.now(),
      });
      return executorDetail(ctx, row.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/executors/:id/meters/read',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      requireReason(req.body);
      const [row] = await db
        .select({ id: executors.id })
        .from(executors)
        .where(eq(executors.id, req.params.id));
      if (!row) throw notFound('Executor');
      await ctx.pipeline.readMetersNow(row.id);
      return meterGauges(ctx, [row.id]);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/executors/:id/soft-hold/clear',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      await ctx.pipeline.clearSoftHold(req.params.id, actorOf(req), reason);
      return executorDetail(ctx, req.params.id);
    },
  );

  app.delete<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/executors/:id',
    operator,
    async (req, reply) => {
      const reason = requireReason(req.body);
      const [row] = await db.select().from(executors).where(eq(executors.id, req.params.id));
      if (!row) throw notFound('Executor');
      const users = await processesUsing(ctx, row.id);
      if (users.length > 0)
        throw conflict(`Still used by ${users.join(', ')}. Bind those processes elsewhere first.`);
      await db.delete(executors).where(eq(executors.id, row.id));
      await ctx.host.reload('executor', row.id);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'executor',
        targetId: row.id,
        field: 'deleted',
        before: { name: row.name, typeId: row.typeId },
        reason,
        at: clock.now(),
      });
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------------------------------------
  // Notifiers and secret providers
  // ------------------------------------------------------------------------------------------

  for (const kind of ['notifier', 'secret_provider'] as const) {
    const table = kind === 'notifier' ? notifiers : secretProviders;
    const base = kind === 'notifier' ? '/api/v1/notifiers' : '/api/v1/secret-providers';
    const typeOf = (typeId: string) =>
      kind === 'notifier'
        ? ctx.runtime.notifierType(typeId)?.type
        : ctx.runtime.secretProviderType(typeId)?.type;

    const summarize = (row: typeof notifiers.$inferSelect): InstanceSummary => {
      const type = typeOf(row.typeId);
      const error = ctx.runtime.instanceError(row.id);
      return {
        id: row.id,
        kind,
        typeId: row.typeId,
        typeName: type?.displayName ?? row.typeId,
        name: row.name,
        enabled: row.enabled,
        status: instanceStatus({ enabled: row.enabled, health: row.health, instanceError: error }),
        health: row.health,
        settings: row.settings,
        settingsSchema: type?.settingsSchema ?? { type: 'object' },
        instanceError: error ?? null,
      };
    };
    const load = async (id: string) => {
      const [row] = await db.select().from(table).where(eq(table.id, id));
      if (!row) throw notFound(kind === 'notifier' ? 'Notifier' : 'Secret provider');
      return row;
    };
    const checkName = (name: string): string => {
      const n = nonEmptyName(name);
      if (kind === 'secret_provider' && !/^[a-z0-9][a-z0-9-]*$/.test(n)) {
        throw badRequest(
          'A secret provider name is the <provider> in secret://<provider>/<name>: lower-case letters, digits and dashes.',
        );
      }
      return n;
    };

    app.get(base, viewer, async () =>
      (await db.select().from(table).orderBy(table.name)).map(summarize),
    );

    app.post<{ Body: CreateInstanceRequest }>(
      base,
      { ...admin, schema: { body: reasoned } },
      async (req, reply) => {
        const reason = requireReason(req.body);
        const type = typeOf(req.body.typeId);
        if (!type)
          throw unprocessable(
            `No installed plugin provides ${kind.replace('_', ' ')} type "${req.body.typeId}".`,
          );
        const settings = validateSettings(type.settingsSchema, req.body.settings);
        const name = checkName(req.body.name);
        const now = clock.now();
        const [row] = await db
          .insert(table)
          .values({
            typeId: req.body.typeId,
            name,
            settings,
            enabled: req.body.enabled ?? true,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row) throw new HttpError(500, 'internal', 'insert failed');
        await ctx.host.reload(kind, row.id);
        await recordAudit(db, {
          actor: actorOf(req),
          scope: kind,
          targetId: row.id,
          field: 'created',
          after: { name, typeId: row.typeId, settings },
          reason,
          at: now,
        });
        return reply.code(201).send(summarize(row));
      },
    );

    app.put<{ Params: { id: string }; Body: UpdateInstanceRequest }>(
      `${base}/:id`,
      { ...admin, schema: { body: reasoned } },
      async (req) => {
        const reason = requireReason(req.body);
        const before = await load(req.params.id);
        const type = typeOf(before.typeId);
        const settings =
          req.body.settings && type
            ? validateSettings(type.settingsSchema, req.body.settings)
            : (req.body.settings ?? before.settings);
        const name = req.body.name !== undefined ? checkName(req.body.name) : before.name;
        const now = clock.now();
        await db
          .update(table)
          .set({ name, settings, updatedAt: now })
          .where(eq(table.id, before.id));
        await ctx.host.reload(kind, before.id);
        await recordAuditDiff(
          db,
          { actor: actorOf(req), scope: kind, targetId: before.id, reason, at: now },
          { name: before.name, ...prefix('settings', before.settings) },
          { name, ...prefix('settings', settings) },
        );
        return summarize(await load(before.id));
      },
    );

    app.post<{ Params: { id: string }; Body: EnableRequest }>(
      `${base}/:id/enable`,
      { ...admin, schema: { body: reasoned } },
      async (req) => {
        const reason = requireReason(req.body);
        const before = await load(req.params.id);
        const now = clock.now();
        await db
          .update(table)
          .set({ enabled: req.body.enabled, updatedAt: now })
          .where(eq(table.id, before.id));
        await ctx.host.reload(kind, before.id);
        await recordAudit(db, {
          actor: actorOf(req),
          scope: kind,
          targetId: before.id,
          field: 'enabled',
          before: before.enabled,
          after: req.body.enabled,
          reason,
          at: now,
        });
        return summarize(await load(before.id));
      },
    );

    app.post<{ Params: { id: string }; Body: { reason: string } }>(
      `${base}/:id/reload`,
      { ...admin, schema: { body: reasoned } },
      async (req) => {
        const reason = requireReason(req.body);
        const row = await load(req.params.id);
        await ctx.host.reload(kind, row.id);
        if (kind === 'secret_provider') await ctx.host.instantiateAll();
        await recordAudit(db, {
          actor: actorOf(req),
          scope: kind,
          targetId: row.id,
          field: 'reload',
          reason,
          at: clock.now(),
        });
        return summarize(await load(row.id));
      },
    );

    app.delete<{ Params: { id: string }; Body: { reason: string } }>(
      `${base}/:id`,
      admin,
      async (req, reply) => {
        const reason = requireReason(req.body);
        const row = await load(req.params.id);
        if (kind === 'notifier') {
          const users = await processesUsing(ctx, row.id);
          if (users.length > 0) throw conflict(`Still used by ${users.join(', ')}.`);
        }
        await db.delete(table).where(eq(table.id, row.id));
        await ctx.host.reload(kind, row.id);
        await recordAudit(db, {
          actor: actorOf(req),
          scope: kind,
          targetId: row.id,
          field: 'deleted',
          before: { name: row.name, typeId: row.typeId },
          reason,
          at: clock.now(),
        });
        return reply.code(204).send();
      },
    );
  }

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/notifiers/:id/test',
    { ...admin, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const live = ctx.runtime.notifier(req.params.id);
      if (!live) throw notFound('Running notifier');
      try {
        await live.notifier.send({
          on: 'system',
          severity: 'info',
          title: 'Switchboard test notification',
          text: `Sent by ${actorOf(req)}: ${reason}`,
        });
        return { ok: true, message: 'Sent.' };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

/** Flatten `{ a: 1 }` under `settings` into `{ 'settings.a': 1 }` for field-level audit rows. */
function prefix(name: string, obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[`${name}.${k}`] = v;
  return out;
}
