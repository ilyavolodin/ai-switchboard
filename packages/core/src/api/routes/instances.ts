import { secretPaths, validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { actorOf, requireRole } from '../../auth/fastify.js';
import { destinations, notifiers, secretProviders, sources } from '../../db/schema.js';
import { acceptsUnauthenticated } from '../../domain/authentication.js';
import { instanceStatus } from '../../domain/labels.js';
import { literalSecretFields } from '../../secrets/refs.js';
import type { InstanceKind } from '../../plugins/host.js';
import { recordAudit, recordAuditDiff } from '../../services/audit.js';
import {
  clearDestinationHealth,
  deleteInstance,
  findInstance,
  nextConfigVersion,
  requestInstanceReload,
  setInstanceEnabled,
  type InstanceHead,
} from '../../services/instances.js';
import type { ApiContext } from '../context.js';
import type {
  CreateDestinationRequest,
  CreateInstanceRequest,
  CreateSourceRequest,
  EnableRequest,
  InstanceSummary,
  UpdateDestinationRequest,
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
  destinationDetail,
  destinationSummaries,
  processesUsing,
  sourceDetail,
  sourceSummaries,
} from '../read/instances.js';
import { meterGauges } from '../read/meters.js';
import { providerDependents, providerUsers } from '../read/secrets.js';

const reasoned = {
  type: 'object',
  required: ['reason'],
  properties: { reason: { type: 'string' } },
} as const;

const enableBody = {
  type: 'object',
  required: ['reason', 'enabled'],
  properties: { reason: { type: 'string' }, enabled: { type: 'boolean' } },
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

const destinationCapsSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runsPerHour: { type: 'integer', minimum: 0 },
    runsPerDay: { type: 'integer', minimum: 0 },
    usagePerDay: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
    meterPollSeconds: { type: 'integer', minimum: 30, maximum: 86_400 },
    meterStalenessMinutes: { type: 'integer', minimum: 1, maximum: 10_080 },
    estimatedLimits: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
    invokeTimeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
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

/**
 * Without the plugin its schema (and so its secret fields) is unknown: new settings cannot be
 * checked for literal secret values, so they are refused until the plugin is back.
 */
function checkableSchema(type: { settingsSchema: JSONSchema } | undefined): JSONSchema {
  if (!type)
    throw unprocessable(
      'The plugin for this instance is unavailable, so its settings cannot be checked. Reinstall the plugin first.',
    );
  return type.settingsSchema;
}

function validateCaps(schema: JSONSchema, caps: unknown): Record<string, unknown> {
  const copy = structuredClone(caps ?? {}) as Record<string, unknown>;
  const check = validateAgainst(schema, copy);
  if (!check.valid) throw badRequest('Caps are invalid.', check.errors);
  return copy;
}

/** Key-order independent comparison of two caps objects. */
function canonicalCaps(caps: object): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(caps).sort(([a], [b]) => a.localeCompare(b))),
  );
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

  const registerLifecycle = (spec: {
    kind: InstanceKind;
    base: string;
    label: string;
    role: typeof operator;
    view: (id: string) => Promise<unknown>;
    /** Refuse a delete while processes use the instance; the hint ends the 409 message. */
    inUseHint?: string;
    beforeReload?: (id: string) => Promise<void>;
    afterRebuild?: (row: InstanceHead) => Promise<void>;
    /** Throws to refuse the delete (a 409 naming who still uses it). */
    beforeDelete?: (row: InstanceHead) => Promise<void>;
  }): void => {
    const { kind, base, label, role } = spec;
    const load = async (id: string) => {
      const row = await findInstance(db, kind, id);
      if (!row) throw notFound(label);
      return row;
    };

    app.post<{ Params: { id: string }; Body: EnableRequest }>(
      `${base}/:id/enable`,
      { ...role, schema: { body: enableBody } },
      async (req) => {
        const reason = requireReason(req.body);
        const before = await load(req.params.id);
        const now = clock.now();
        await setInstanceEnabled(db, kind, before.id, req.body.enabled, now);
        await ctx.host.reload(kind, before.id);
        await spec.afterRebuild?.(before);
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
        return spec.view(before.id);
      },
    );

    app.post<{ Params: { id: string }; Body: { reason: string } }>(
      `${base}/:id/reload`,
      { ...role, schema: { body: reasoned } },
      async (req) => {
        const reason = requireReason(req.body);
        const row = await load(req.params.id);
        await spec.beforeReload?.(row.id);
        // Bump the version so the other replicas rebuild it too (secret rotation relies on it).
        await requestInstanceReload(db, kind, row.id);
        await ctx.host.reload(kind, row.id);
        await spec.afterRebuild?.(row);
        await recordAudit(db, {
          actor: actorOf(req),
          scope: kind,
          targetId: row.id,
          field: 'reload',
          reason,
          at: clock.now(),
        });
        return spec.view(row.id);
      },
    );

    app.delete<{ Params: { id: string }; Body: { reason: string } }>(
      `${base}/:id`,
      role,
      async (req, reply) => {
        const reason = requireReason(req.body);
        const row = await load(req.params.id);
        if (spec.inUseHint !== undefined) {
          const users = await processesUsing(ctx, row.id);
          if (users.length > 0)
            throw conflict(
              `Still used by ${users.map((u) => u.name).join(', ')}.${spec.inUseHint}`,
              users,
            );
        }
        await spec.beforeDelete?.(row);
        await deleteInstance(db, kind, row.id);
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
  };

  /**
   * A push instance must verify deliveries. Only a type that allows it (the generic webhook) may
   * build one without `verify`, and `caps.unauthenticated` is derived from the built instance,
   * whatever the request said.
   */
  const authenticationCaps = (
    id: string,
    typeId: string,
    caps: object,
    previous: boolean,
  ): Record<string, unknown> => {
    const rest: Record<string, unknown> = { ...caps };
    delete rest.unauthenticated;
    const type = ctx.runtime.sourceType(typeId)?.type;
    const live = ctx.runtime.source(id);
    // Without the plugin or a built instance there is nothing to derive from: keep what was.
    if (!type || !live) return previous ? { ...rest, unauthenticated: true } : rest;
    if (type.mode !== 'pull' && typeof live.source.verify !== 'function') {
      if (!acceptsUnauthenticated(type, live.source))
        throw unprocessable(
          `${type.displayName} sources must verify deliveries: configure verification in the settings.`,
        );
      return { ...rest, unauthenticated: true };
    }
    return rest;
  };

  registerLifecycle({
    kind: 'source',
    base: '/api/v1/sources',
    label: 'Source',
    role: operator,
    view: (id) => sourceDetail(ctx, id),
    inUseHint: ' Remove it from those processes first.',
  });

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
      const requestedCaps = validateCaps(sourceCapsSchema, req.body.caps);
      const name = nonEmptyName(req.body.name);
      const now = clock.now();
      const [row] = await db
        .insert(sources)
        .values({
          typeId: req.body.typeId,
          name,
          settings,
          caps: requestedCaps,
          enabled: req.body.enabled ?? true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new HttpError(500, 'internal', 'insert failed');
      await ctx.host.reload('source', row.id);
      let caps: Record<string, unknown>;
      try {
        caps = authenticationCaps(row.id, row.typeId, row.caps, false);
      } catch (err) {
        await db.delete(sources).where(eq(sources.id, row.id));
        await ctx.host.reload('source', row.id);
        throw err;
      }
      if (canonicalCaps(caps) !== canonicalCaps(row.caps))
        await db.update(sources).set({ caps }).where(eq(sources.id, row.id));
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
      const settings = req.body.settings
        ? validateSettings(checkableSchema(typeEntry?.type), req.body.settings)
        : before.settings;
      const requestedCaps = req.body.caps
        ? validateCaps(sourceCapsSchema, req.body.caps)
        : before.caps;
      const name = req.body.name !== undefined ? nonEmptyName(req.body.name) : before.name;
      const now = clock.now();
      await db
        .update(sources)
        .set({
          name,
          settings,
          caps: requestedCaps,
          updatedAt: now,
          configVersion: nextConfigVersion(sources),
        })
        .where(eq(sources.id, before.id));
      await ctx.host.reload('source', before.id);
      let caps: Record<string, unknown>;
      try {
        caps = authenticationCaps(
          before.id,
          before.typeId,
          requestedCaps,
          before.caps.unauthenticated === true,
        );
        if (canonicalCaps(caps) !== canonicalCaps(requestedCaps))
          await db.update(sources).set({ caps }).where(eq(sources.id, before.id));
      } catch (err) {
        await db
          .update(sources)
          .set({
            name: before.name,
            settings: before.settings,
            caps: before.caps,
            updatedAt: now,
            configVersion: nextConfigVersion(sources),
          })
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

  registerLifecycle({
    kind: 'destination',
    base: '/api/v1/destinations',
    label: 'Destination',
    role: operator,
    view: (id) => destinationDetail(ctx, id),
    inUseHint: ' Bind those processes elsewhere first.',
    // A reload clears an "unhealthy" mark set after 401/403; the next health check re-evaluates.
    beforeReload: (id) => clearDestinationHealth(db, id),
  });

  app.get('/api/v1/destinations', viewer, async () => destinationSummaries(ctx));
  app.get<{ Params: { id: string } }>('/api/v1/destinations/:id', viewer, async (req) =>
    destinationDetail(ctx, req.params.id),
  );

  app.post<{ Body: CreateDestinationRequest }>(
    '/api/v1/destinations',
    { ...operator, schema: { body: reasoned } },
    async (req, reply) => {
      const reason = requireReason(req.body);
      const typeEntry = ctx.runtime.destinationType(req.body.typeId);
      if (!typeEntry)
        throw unprocessable(`No installed plugin provides destination type "${req.body.typeId}".`);
      const settings = validateSettings(typeEntry.type.settingsSchema, req.body.settings);
      const caps = validateCaps(destinationCapsSchema, req.body.caps);
      const name = nonEmptyName(req.body.name);
      const now = clock.now();
      const [row] = await db
        .insert(destinations)
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
      await ctx.host.reload('destination', row.id);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'destination',
        targetId: row.id,
        field: 'created',
        after: { name, typeId: row.typeId, settings, caps },
        reason,
        at: now,
      });
      return reply.code(201).send(await destinationDetail(ctx, row.id));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateDestinationRequest }>(
    '/api/v1/destinations/:id',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const [before] = await db
        .select()
        .from(destinations)
        .where(eq(destinations.id, req.params.id));
      if (!before) throw notFound('Destination');
      const typeEntry = ctx.runtime.destinationType(before.typeId);
      const settings = req.body.settings
        ? validateSettings(checkableSchema(typeEntry?.type), req.body.settings)
        : before.settings;
      const caps = req.body.caps ? validateCaps(destinationCapsSchema, req.body.caps) : before.caps;
      const name = req.body.name !== undefined ? nonEmptyName(req.body.name) : before.name;
      const targetDefaults = req.body.targetDefaults ?? before.targetDefaults;
      const now = clock.now();
      await db
        .update(destinations)
        .set({
          name,
          settings,
          caps,
          targetDefaults,
          updatedAt: now,
          configVersion: nextConfigVersion(destinations),
        })
        .where(eq(destinations.id, before.id));
      await ctx.host.reload('destination', before.id);
      await recordAuditDiff(
        db,
        { actor: actorOf(req), scope: 'destination', targetId: before.id, reason, at: now },
        {
          name: before.name,
          ...prefix('settings', before.settings),
          ...prefix('caps', before.caps),
          targetDefaults: before.targetDefaults,
        },
        { name, ...prefix('settings', settings), ...prefix('caps', caps), targetDefaults },
      );
      return destinationDetail(ctx, before.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/destinations/:id/meters/read',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const [row] = await db
        .select({ id: destinations.id })
        .from(destinations)
        .where(eq(destinations.id, req.params.id));
      if (!row) throw notFound('Destination');
      await ctx.pipeline.readMetersNow(row.id);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'destination',
        targetId: row.id,
        field: 'meters_read',
        reason,
        at: clock.now(),
      });
      return meterGauges(ctx, [row.id]);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/destinations/:id/soft-hold/clear',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      await ctx.pipeline.clearSoftHold(req.params.id, actorOf(req), reason);
      return destinationDetail(ctx, req.params.id);
    },
  );

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
        typeIcon: type?.icon ?? null,
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
    const view = async (row: typeof notifiers.$inferSelect): Promise<InstanceSummary> => {
      if (kind !== 'secret_provider') return summarize(row);
      const dependents = await providerDependents(ctx, [row.name]);
      return { ...summarize(row), dependents: dependents.get(row.name) ?? [] };
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

    registerLifecycle({
      kind,
      base,
      label: kind === 'notifier' ? 'Notifier' : 'Secret provider',
      role: admin,
      view: async (id) => view(await load(id)),
      ...(kind === 'secret_provider'
        ? {
            // Instances resolve their secrets when built: rebuild the ones that use this provider.
            afterRebuild: async (row: InstanceHead) => {
              await ctx.host.reloadDependentsOf(row.name);
            },
            beforeDelete: async (row: InstanceHead) => {
              const users = await providerUsers(ctx, row.name, row.id);
              if (users.length > 0)
                throw conflict(
                  `Still used by ${users.map((u) => `${u.kind.replace('_', ' ')} "${u.name}"`).join(', ')}. Point their secret://${row.name}/… references at another provider first.`,
                );
            },
          }
        : { inUseHint: '' }),
    });

    app.get(base, viewer, async () => {
      const rows = await db.select().from(table).orderBy(table.name);
      if (kind !== 'secret_provider') return rows.map(summarize);
      const dependents = await providerDependents(
        ctx,
        rows.map((r) => r.name),
      );
      return rows.map((r) => ({ ...summarize(r), dependents: dependents.get(r.name) ?? [] }));
    });

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
        // References to this name that failed before the provider existed resolve now.
        if (kind === 'secret_provider') await ctx.host.reloadDependentsOf(row.name);
        await recordAudit(db, {
          actor: actorOf(req),
          scope: kind,
          targetId: row.id,
          field: 'created',
          after: { name, typeId: row.typeId, settings },
          reason,
          at: now,
        });
        return reply.code(201).send(await view(row));
      },
    );

    app.put<{ Params: { id: string }; Body: UpdateInstanceRequest }>(
      `${base}/:id`,
      { ...admin, schema: { body: reasoned } },
      async (req) => {
        const reason = requireReason(req.body);
        const before = await load(req.params.id);
        const type = typeOf(before.typeId);
        const settings = req.body.settings
          ? validateSettings(checkableSchema(type), req.body.settings)
          : before.settings;
        const name = req.body.name !== undefined ? checkName(req.body.name) : before.name;
        const now = clock.now();
        await db
          .update(table)
          .set({ name, settings, updatedAt: now, configVersion: nextConfigVersion(table) })
          .where(eq(table.id, before.id));
        await ctx.host.reload(kind, before.id);
        // After a rename, instances still naming the old provider fail with a secret_error;
        // nothing rewrites their references.
        if (kind === 'secret_provider')
          await ctx.host.reloadDependentsOf([...new Set([before.name, name])]);
        await recordAuditDiff(
          db,
          { actor: actorOf(req), scope: kind, targetId: before.id, reason, at: now },
          { name: before.name, ...prefix('settings', before.settings) },
          { name, ...prefix('settings', settings) },
        );
        return view(await load(before.id));
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
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'notifier',
        targetId: live.id,
        field: 'test_sent',
        reason,
        at: clock.now(),
      });
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
