import { SDK_VERSION, validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';
import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { roleAtLeast } from '../../auth/crypto.js';
import { actorOf, requireRole } from '../../auth/fastify.js';
import { passwordProblem } from '../../auth/password-policy.js';
import { createApiToken, revokeUserSessions } from '../../auth/sessions.js';
import {
  apiTokens,
  auditLog,
  destinations,
  notifiers,
  plugins,
  processes,
  replicas,
  secretProviders,
  sources,
  users,
} from '../../db/schema.js';
import type { DbOrTx } from '../../db/client.js';
import { ROLES, type Role } from '../../domain/status.js';
import { recordAudit, recordAuditDiff } from '../../services/audit.js';
import { getSettings, putSettings } from '../../services/settings.js';
import { removePassword, storePassword } from '../../services/users.js';
import { telemetryStatus } from '../../telemetry/otel-config.js';
import type { ApiContext } from '../context.js';
import type {
  AboutResponse,
  ApiTokenDTO,
  AuditEntry,
  AuditQuery,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  CreateUserRequest,
  GlobalSettings,
  Page,
  SetPasswordRequest,
  UpdateSettingsRequest,
  UpdateUserRequest,
  UserDirectoryEntry,
} from '../contract.js';
import { badRequest, conflict, HttpError, notFound, requireReason } from '../errors.js';
import { decodeCursor, encodeCursor, pageLimit } from '../read/paging.js';
import { toUserDTO } from './auth.js';

const reasoned = {
  type: 'object',
  required: ['reason'],
  properties: { reason: { type: 'string' } },
} as const;

const hhmm = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' };
const settingsSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timezone: { type: 'string', minLength: 1 },
    defaultQuietHours: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['start', 'end'],
          additionalProperties: false,
          properties: {
            start: hhmm,
            end: hhmm,
            days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 } },
          },
        },
      ],
    },
    meterStalenessMinutes: { type: 'integer', minimum: 1, maximum: 10_080 },
    retention: {
      type: 'object',
      additionalProperties: false,
      properties: {
        eventsDays: { type: 'integer', minimum: 1 },
        rawBodiesDays: { type: 'integer', minimum: 1 },
        dispatchesDays: { type: 'integer', minimum: 1 },
        meterReadingsDays: { type: 'integer', minimum: 1 },
        statsHourlyDays: { type: 'integer', minimum: 1 },
      },
    },
    oidc: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['issuer', 'clientId', 'allowedDomains'],
          properties: {
            issuer: { type: 'string' },
            clientId: { type: 'string' },
            allowedDomains: { type: 'array', items: { type: 'string' } },
          },
        },
      ],
    },
    systemNotifierId: { anyOf: [{ type: 'null' }, { type: 'string' }] },
    sourceSilenceMinutes: { type: 'integer', minimum: 1 },
    requireReasons: { type: 'boolean' },
    export: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schedule: { anyOf: [{ type: 'null' }, { type: 'string' }] },
        sourceId: { anyOf: [{ type: 'null' }, { type: 'string' }] },
        repository: { anyOf: [{ type: 'null' }, { type: 'string' }] },
        path: { anyOf: [{ type: 'null' }, { type: 'string' }] },
        branch: { anyOf: [{ type: 'null' }, { type: 'string' }] },
      },
    },
  },
};

function tokenDTO(row: typeof apiTokens.$inferSelect): ApiTokenDTO {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Refuse (409) unless another admin remains. Locks the admin rows, so two admins demoting or
 * removing each other at the same moment cannot both succeed.
 */
async function keepAnotherAdmin(tx: DbOrTx, message: string): Promise<void> {
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .for('update');
  if (admins.length <= 1) throw conflict(message);
}

function checkRole(role: unknown): Role {
  if (typeof role !== 'string' || !ROLES.includes(role as Role))
    throw badRequest(`role must be one of ${ROLES.join(', ')}`);
  return role as Role;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, clock, config } = ctx;
  const viewer = { preHandler: requireRole('viewer') };
  const admin = { preHandler: requireRole('admin') };

  app.get('/api/v1/settings', viewer, async () => getSettings(db));

  app.put<{ Body: UpdateSettingsRequest }>(
    '/api/v1/settings',
    { ...admin, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const patch = structuredClone(req.body.settings);
      const check = validateAgainst(settingsSchema, patch);
      if (!check.valid) throw badRequest('Settings are invalid.', check.errors);
      const before = await getSettings(db);
      if (patch.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: patch.timezone });
        } catch {
          throw badRequest(`Unknown timezone ${patch.timezone}`);
        }
      }
      const after: GlobalSettings = {
        ...before,
        ...patch,
        retention: { ...before.retention, ...patch.retention },
        export: { ...before.export, ...patch.export },
      };
      const now = clock.now();
      await db.transaction(async (tx) => {
        await putSettings(tx, after, now);
        await recordAuditDiff(
          tx,
          { actor: actorOf(req), scope: 'settings', targetId: 'global', reason, at: now },
          before as unknown as Record<string, unknown>,
          after as unknown as Record<string, unknown>,
        );
      });
      // This replica sees the new policy at once; others within the policy's TTL.
      app.reasons.invalidate();
      return after;
    },
  );

  app.get('/api/v1/users', admin, async () =>
    (await db.select().from(users).orderBy(users.email)).map(toUserDTO),
  );

  // Every role may see who has access and with which role (the Users tab, read-only); how and
  // when they sign in stays admin-only.
  app.get(
    '/api/v1/users/directory',
    viewer,
    async (): Promise<UserDirectoryEntry[]> =>
      await db
        .select({ id: users.id, email: users.email, role: users.role })
        .from(users)
        .orderBy(users.email),
  );

  app.post<{ Body: CreateUserRequest }>(
    '/api/v1/users',
    { ...admin, schema: { body: reasoned } },
    async (req, reply) => {
      const reason = requireReason(req.body);
      const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('A valid email is required.');
      const role = checkRole(req.body.role);
      const password = req.body.password;
      if (password !== undefined) {
        if (typeof password !== 'string') throw badRequest('password must be a string');
        const problem = passwordProblem(password, email);
        if (problem) throw badRequest(problem);
      }
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing.length > 0) throw conflict(`${email} already has access.`);
      const now = clock.now();
      const row = await db.transaction(async (tx) => {
        const [r] = await tx.insert(users).values({ email, role, createdAt: now }).returning();
        if (!r) throw new HttpError(500, 'internal', 'insert failed');
        await recordAudit(tx, {
          actor: actorOf(req),
          scope: 'user',
          targetId: r.id,
          field: 'role',
          after: role,
          reason,
          at: now,
        });
        if (password === undefined) return r;
        const withPassword = await storePassword(tx, r.id, password, {
          temporary: true,
          field: 'password',
          audit: { actor: actorOf(req), reason, at: now },
        });
        return withPassword ?? r;
      });
      return reply.code(201).send(toUserDTO(row));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateUserRequest }>(
    '/api/v1/users/:id',
    { ...admin, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const role = checkRole(req.body.role);
      const now = clock.now();
      const [row] = await db.transaction(async (tx) => {
        const [before] = await tx.select().from(users).where(eq(users.id, req.params.id));
        if (!before) throw notFound('User');
        if (before.role === 'admin' && role !== 'admin')
          await keepAnotherAdmin(tx, 'This is the last admin; add another admin first.');
        const r = await tx.update(users).set({ role }).where(eq(users.id, before.id)).returning();
        await recordAudit(tx, {
          actor: actorOf(req),
          scope: 'user',
          targetId: before.id,
          field: 'role',
          before: before.role,
          after: role,
          reason,
          at: now,
        });
        return r;
      });
      if (!row) throw notFound('User');
      return toUserDTO(row);
    },
  );

  app.delete<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/users/:id',
    admin,
    async (req, reply) => {
      const reason = requireReason(req.body);
      const now = clock.now();
      await db.transaction(async (tx) => {
        const [before] = await tx.select().from(users).where(eq(users.id, req.params.id));
        if (!before) throw notFound('User');
        if (before.id === req.user?.id) throw conflict('You cannot remove yourself.');
        if (before.role === 'admin') await keepAnotherAdmin(tx, 'This is the last admin.');
        await revokeUserSessions(tx, before.id);
        await tx.update(apiTokens).set({ revokedAt: now }).where(eq(apiTokens.userId, before.id));
        await tx.delete(users).where(eq(users.id, before.id));
        await recordAudit(tx, {
          actor: actorOf(req),
          scope: 'user',
          targetId: before.id,
          field: 'deleted',
          before: { email: before.email, role: before.role },
          reason,
          at: now,
        });
      });
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { id: string }; Body: SetPasswordRequest }>(
    '/api/v1/users/:id/password',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['reason', 'password'],
          properties: { reason: { type: 'string' }, password: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const reason = requireReason(req.body);
      const [before] = await db.select().from(users).where(eq(users.id, req.params.id));
      if (!before) throw notFound('User');
      if (before.id === req.user?.id)
        throw conflict('Change your own password from your account, not the Users tab.');
      const problem = passwordProblem(req.body.password, before.email);
      if (problem) throw badRequest(problem);
      const now = clock.now();
      const row = await db.transaction((tx) =>
        storePassword(tx, before.id, req.body.password, {
          temporary: true,
          field: before.passwordHash === null ? 'password' : 'password_reset',
          audit: { actor: actorOf(req), reason, at: now },
        }),
      );
      if (!row) throw notFound('User');
      return toUserDTO(row);
    },
  );

  app.delete<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/users/:id/password',
    admin,
    async (req) => {
      const reason = requireReason(req.body);
      const [before] = await db.select().from(users).where(eq(users.id, req.params.id));
      if (!before) throw notFound('User');
      if (before.passwordHash === null) throw conflict(`${before.email} has no password.`);
      if (!ctx.oidc)
        throw conflict(
          'OIDC is not configured; without a password this account could not sign in.',
        );
      const now = clock.now();
      const row = await db.transaction((tx) =>
        removePassword(tx, before.id, { actor: actorOf(req), reason, at: now }),
      );
      if (!row) throw notFound('User');
      return toUserDTO(row);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/users/:id/sessions/revoke',
    { ...admin, schema: { body: reasoned } },
    async (req, reply) => {
      const reason = requireReason(req.body);
      const [row] = await db.select().from(users).where(eq(users.id, req.params.id));
      if (!row) throw notFound('User');
      await revokeUserSessions(db, row.id);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'user',
        targetId: row.id,
        field: 'sessions_revoked',
        reason,
        at: clock.now(),
      });
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/tokens', viewer, async (req) => {
    const rows = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, req.user?.id ?? ''))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(tokenDTO);
  });

  app.post<{ Body: CreateApiTokenRequest }>(
    '/api/v1/tokens',
    { ...viewer, schema: { body: reasoned } },
    async (req, reply): Promise<CreateApiTokenResponse> => {
      const reason = requireReason(req.body);
      const user = req.user;
      if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
      const role = checkRole(req.body.role);
      if (!roleAtLeast(user.role, role))
        throw badRequest(`A token cannot have more than your own role (${user.role}).`);
      const name =
        typeof req.body.name === 'string' && req.body.name.trim() !== ''
          ? req.body.name.trim().slice(0, 80)
          : 'token';
      const now = clock.now();
      const created = await createApiToken(db, user.id, name, role, now);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'token',
        targetId: created.id,
        field: 'created',
        after: { name, role },
        reason,
        at: now,
      });
      const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, created.id));
      if (!row) throw new HttpError(500, 'internal', 'token not found after insert');
      void reply.code(201);
      return { token: tokenDTO(row), secret: created.secret };
    },
  );

  app.delete<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/tokens/:id',
    viewer,
    async (req, reply) => {
      const reason = requireReason(req.body);
      const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, req.params.id));
      if (!row) throw notFound('Token');
      if (row.userId !== req.user?.id && req.user?.role !== 'admin')
        throw new HttpError(403, 'forbidden', 'You can only revoke your own tokens.');
      const now = clock.now();
      await db.update(apiTokens).set({ revokedAt: now }).where(eq(apiTokens.id, row.id));
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'token',
        targetId: row.id,
        field: 'revoked',
        reason,
        at: now,
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Querystring: AuditQuery }>(
    '/api/v1/audit',
    viewer,
    async (req): Promise<Page<AuditEntry>> => {
      const q = req.query;
      const limit = pageLimit(q.limit);
      const cursor = decodeCursor(q.cursor);
      const where: SQL[] = [];
      if (q.scope) where.push(eq(auditLog.scope, q.scope));
      if (q.target) where.push(eq(auditLog.targetId, q.target));
      if (q.actor) {
        const escaped = q.actor.replace(/[\\%_]/g, (c) => `\\${c}`);
        where.push(sql`${auditLog.actor} ILIKE ${`%${escaped}%`}`);
      }
      const after = Number(cursor?.id);
      if (Number.isSafeInteger(after)) where.push(lt(auditLog.id, after));
      const rows = await db
        .select()
        .from(auditLog)
        .where(where.length > 0 ? and(...where) : undefined)
        .orderBy(desc(auditLog.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const names = await targetNames(
        ctx,
        page.map((r) => r.targetId),
      );
      const items = page.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actor: r.actor,
        scope: r.scope,
        targetId: r.targetId,
        targetName: r.targetId ? (names.get(r.targetId) ?? null) : null,
        field: r.field,
        before: r.before,
        after: r.after,
        reason: r.reason,
      }));
      const last = rows[limit - 1];
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ t: last.at.toISOString(), id: String(last.id) })
            : null,
      };
    },
  );

  app.get('/api/v1/about', viewer, async (): Promise<AboutResponse> => {
    const now = clock.now().getTime();
    const [reps, pluginRows, version] = await Promise.all([
      db.select().from(replicas).orderBy(desc(replicas.heartbeatAt)),
      db.select({ name: plugins.name }).from(plugins).where(eq(plugins.status, 'loaded')),
      db.execute<{ version: string }>(sql`select version()`).then(
        (r) => r.rows[0]?.version ?? null,
        () => null,
      ),
    ]);
    return {
      version: config.version,
      sdkVersion: SDK_VERSION,
      replicas: reps.map((r) => ({
        id: r.id,
        hostname: r.hostname,
        version: r.version,
        startedAt: r.startedAt.toISOString(),
        heartbeatAt: r.heartbeatAt.toISOString(),
        live: now - r.heartbeatAt.getTime() < 90_000,
      })),
      database: { ok: version !== null, version },
      plugins: pluginRows.length,
      evaluation: config.evaluation,
      publicUrl: config.publicUrl,
      telemetry: telemetryStatus(config.telemetry),
    };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id → display name for the audit rows on one page, across instances, users and processes. */
async function targetNames(
  ctx: ApiContext,
  targetIds: (string | null)[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Plugin names, `global` and bootstrap emails are not row ids.
  const ids = [...new Set(targetIds.filter((id): id is string => id !== null && UUID.test(id)))];
  if (ids.length === 0) return out;
  const lists = await Promise.all([
    ctx.db
      .select({ id: processes.id, name: processes.name })
      .from(processes)
      .where(inArray(processes.id, ids)),
    ctx.db
      .select({ id: sources.id, name: sources.name })
      .from(sources)
      .where(inArray(sources.id, ids)),
    ctx.db
      .select({ id: destinations.id, name: destinations.name })
      .from(destinations)
      .where(inArray(destinations.id, ids)),
    ctx.db
      .select({ id: notifiers.id, name: notifiers.name })
      .from(notifiers)
      .where(inArray(notifiers.id, ids)),
    ctx.db
      .select({ id: secretProviders.id, name: secretProviders.name })
      .from(secretProviders)
      .where(inArray(secretProviders.id, ids)),
    ctx.db.select({ id: users.id, name: users.email }).from(users).where(inArray(users.id, ids)),
  ]);
  for (const list of lists) for (const r of list) out.set(r.id, r.name);
  return out;
}
