import { validateAgainst } from '@ai-switchboard/sdk';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import jsonata from 'jsonata';

import { actorOf, requireRole } from '../../auth/fastify.js';
import {
  batches,
  executors,
  notifiers,
  processes,
  processVersions,
  sources,
} from '../../db/schema.js';
import { processDocumentSchema, type ProcessDocument } from '../../domain/process.js';
import { recordAudit, recordAuditDiff } from '../../services/audit.js';
import type { DbOrTx } from '../../db/client.js';
import type { ApiContext } from '../context.js';
import type {
  CreateProcessRequest,
  CronPreviewRequest,
  EnableRequest,
  FilterPreviewRequest,
  InputPreviewRequest,
  ProcessVersionDetail,
  ProcessVersionSummary,
  RecentBatchDTO,
  RunNowRequest,
  UpdateProcessRequest,
} from '../contract.js';
import { badRequest, conflict, HttpError, notFound, requireReason } from '../errors.js';
import { processDetail, processSummaries } from '../read/processes.js';
import { batchArtifacts } from '../read/runs.js';

const reasoned = {
  type: 'object',
  required: ['reason'],
  properties: { reason: { type: 'string' } },
} as const;

function compileError(expr: string | undefined): string | null {
  if (expr === undefined || expr.trim() === '') return null;
  try {
    jsonata(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Structural (JSON Schema) and semantic validation: referenced instances exist, event types are
 * declared by the source, the target matches the executor's targetSchema, expressions compile,
 * crons parse.
 */
export async function validateProcessDocument(
  ctx: ApiContext,
  input: unknown,
  db: DbOrTx = ctx.db,
): Promise<ProcessDocument> {
  const doc = structuredClone(input) as ProcessDocument;
  const check = validateAgainst(processDocumentSchema, doc);
  if (!check.valid) throw badRequest('The process document is invalid.', check.errors);
  const problems: string[] = [];

  const srcRows = await db
    .select({ id: sources.id, typeId: sources.typeId, name: sources.name })
    .from(sources);
  const triggerIds = new Set<string>();
  for (const [i, t] of doc.triggers.entries()) {
    if (triggerIds.has(t.id)) problems.push(`triggers[${i}].id "${t.id}" is used twice`);
    triggerIds.add(t.id);
    const src = srcRows.find((s) => s.id === t.sourceId);
    if (!src) {
      problems.push(`triggers[${i}] references a source that does not exist`);
      continue;
    }
    const live = ctx.runtime.source(src.id);
    const srcType = ctx.runtime.sourceType(src.typeId)?.type;
    // A dynamic source (webhook) declares its types per instance; without a live object, skip the check.
    const declaredList =
      live?.eventTypes ?? (srcType?.dynamicEventTypes ? [] : (srcType?.eventTypes ?? []));
    const declared = new Set(declaredList.map((e) => e.type));
    if (declared.size > 0) {
      for (const et of t.eventTypes) {
        if (!declared.has(et))
          problems.push(`triggers[${i}]: ${src.name} does not declare event type ${et}`);
      }
    }
    const err = compileError(t.filter);
    if (err) problems.push(`triggers[${i}].filter: ${err}`);
  }

  const scheduleIds = new Set<string>();
  for (const [i, s] of doc.schedules.entries()) {
    if (scheduleIds.has(s.id)) problems.push(`schedules[${i}].id "${s.id}" is used twice`);
    scheduleIds.add(s.id);
    const preview = ctx.preview.cronPreview({ cron: s.cron, timezone: s.timezone });
    if (!preview.valid) problems.push(`schedules[${i}]: ${preview.error ?? 'invalid cron'}`);
  }

  const [ex] = await db.select().from(executors).where(eq(executors.id, doc.executor.instanceId));
  if (!ex) {
    problems.push('executor.instanceId references an executor that does not exist');
  } else {
    const type = ctx.runtime.executorType(ex.typeId)?.type;
    if (type) {
      const target = { ...ex.targetDefaults, ...(doc.executor.target as Record<string, unknown>) };
      const t = validateAgainst(type.targetSchema, target);
      if (!t.valid)
        problems.push(
          ...t.errors.map((e) => `executor.target${e.startsWith('(root)') ? e.slice(6) : ` ${e}`}`),
        );
    }
    const live = ctx.runtime.executor(ex.id);
    // An executor created in the same apply has no live object yet: ask the type about this
    // instance's settings (usage and meters may be declared per instance, as http does).
    const usage = live?.usage ?? (type ? (type.usageFor?.(ex.settings) ?? type.usage) : []);
    const meterSpecs =
      live?.meters ?? (type ? (type.metersFor?.(ex.settings) ?? type.meters ?? []) : []);
    const budgetable = new Set(usage.filter((d) => d.budgetable).map((d) => d.id));
    for (const dim of Object.keys(doc.budgets.usagePerDay ?? {})) {
      if (!budgetable.has(dim))
        problems.push(`budgets.usagePerDay.${dim}: not a budgetable usage dimension of ${ex.name}`);
    }
    const meters = new Set(meterSpecs.map((m) => m.id));
    for (const m of Object.keys(doc.budgets.meterCeilings)) {
      if (!meters.has(m))
        problems.push(`budgets.meterCeilings.${m}: ${ex.name} has no meter "${m}"`);
    }
  }

  for (const [label, expr] of [
    ['input', doc.input],
    ['batching.groupBy', doc.batching.groupBy],
    [
      'gates.approval',
      doc.gates.approval === 'none' || doc.gates.approval === 'always'
        ? undefined
        : doc.gates.approval,
    ],
  ] as const) {
    const err = compileError(expr);
    if (err) problems.push(`${label}: ${err}`);
  }

  const exRows = await db.select({ id: executors.id }).from(executors);
  const providers = new Set([...srcRows.map((s) => s.id), ...exRows.map((e) => e.id)]);
  for (const phase of ['before', 'after'] as const) {
    for (const [i, s] of doc[phase].entries()) {
      if (!providers.has(s.provider)) problems.push(`${phase}[${i}].provider does not exist`);
      for (const [k, e] of [
        ['args', s.args],
        ['when', s.when],
      ] as const) {
        const err = compileError(e);
        if (err) problems.push(`${phase}[${i}].${k}: ${err}`);
      }
    }
  }
  const nRows = await db.select({ id: notifiers.id }).from(notifiers);
  for (const [i, n] of doc.notify.entries()) {
    if (!nRows.some((r) => r.id === n.notifierId))
      problems.push(`notify[${i}].notifierId does not exist`);
    const err = compileError(n.template);
    if (err) problems.push(`notify[${i}].template: ${err}`);
  }

  if (problems.length > 0)
    throw new HttpError(422, 'invalid_process', 'The process cannot be saved as it is.', problems);
  return doc;
}

export function registerProcessRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, clock } = ctx;
  const viewer = { preHandler: requireRole('viewer') };
  const operator = { preHandler: requireRole('operator') };

  app.get('/api/v1/processes', viewer, async () => processSummaries(ctx));
  app.get<{ Params: { id: string } }>('/api/v1/processes/:id', viewer, async (req) =>
    processDetail(ctx, req.params.id),
  );

  app.post<{ Body: CreateProcessRequest }>(
    '/api/v1/processes',
    { ...operator, schema: { body: reasoned } },
    async (req, reply) => {
      const reason = requireReason(req.body);
      const doc = await validateProcessDocument(ctx, req.body.document);
      const now = clock.now();
      const actor = actorOf(req);
      const id = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(processes)
          .values({
            name: doc.name,
            document: doc,
            enabled: doc.enabled,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: processes.id });
        if (!row) throw new HttpError(500, 'internal', 'insert failed');
        await tx.insert(processVersions).values({
          processId: row.id,
          version: 1,
          document: doc,
          savedBy: actor,
          savedAt: now,
          reason,
        });
        await recordAudit(tx, {
          actor,
          scope: 'process',
          targetId: row.id,
          field: 'created',
          after: doc,
          reason,
          at: now,
        });
        return row.id;
      });
      return reply.code(201).send(await processDetail(ctx, id));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateProcessRequest }>(
    '/api/v1/processes/:id',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const doc = await validateProcessDocument(ctx, req.body.document);
      const now = clock.now();
      const actor = actorOf(req);
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(processes)
          .where(eq(processes.id, req.params.id))
          .for('update');
        if (!before) throw notFound('Process');
        if (req.body.expectedVersion !== before.version) {
          throw conflict(
            `The process was changed by someone else (version ${before.version}); reload and reapply your edit.`,
          );
        }
        const version = before.version + 1;
        await tx
          .update(processes)
          .set({ name: doc.name, document: doc, enabled: doc.enabled, version, updatedAt: now })
          .where(eq(processes.id, before.id));
        await tx.insert(processVersions).values({
          processId: before.id,
          version,
          document: doc,
          savedBy: actor,
          savedAt: now,
          reason,
        });
        await recordAuditDiff(
          tx,
          { actor, scope: 'process', targetId: before.id, reason, at: now },
          flatten(before.document as unknown as Record<string, unknown>),
          flatten(doc as unknown as Record<string, unknown>),
        );
      });
      return processDetail(ctx, req.params.id);
    },
  );

  app.post<{ Params: { id: string }; Body: EnableRequest }>(
    '/api/v1/processes/:id/enable',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const now = clock.now();
      const actor = actorOf(req);
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(processes)
          .where(eq(processes.id, req.params.id))
          .for('update');
        if (!before) throw notFound('Process');
        const doc = { ...before.document, enabled: req.body.enabled };
        const version = before.version + 1;
        await tx
          .update(processes)
          .set({ enabled: req.body.enabled, document: doc, version, updatedAt: now })
          .where(eq(processes.id, before.id));
        await tx.insert(processVersions).values({
          processId: before.id,
          version,
          document: doc,
          savedBy: actor,
          savedAt: now,
          reason,
        });
        await recordAudit(tx, {
          actor,
          scope: 'process',
          targetId: before.id,
          field: 'enabled',
          before: before.enabled,
          after: req.body.enabled,
          reason,
          at: now,
        });
      });
      return processDetail(ctx, req.params.id);
    },
  );

  app.delete<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/processes/:id',
    operator,
    async (req, reply) => {
      const reason = requireReason(req.body);
      const [row] = await db.select().from(processes).where(eq(processes.id, req.params.id));
      if (!row) throw notFound('Process');
      await db.transaction(async (tx) => {
        await tx.delete(processes).where(eq(processes.id, row.id));
        await recordAudit(tx, {
          actor: actorOf(req),
          scope: 'process',
          targetId: row.id,
          field: 'deleted',
          before: row.document,
          reason,
          at: clock.now(),
        });
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: RunNowRequest }>(
    '/api/v1/processes/:id/run',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const [row] = await db
        .select({ id: processes.id })
        .from(processes)
        .where(eq(processes.id, req.params.id));
      if (!row) throw notFound('Process');
      const result = await ctx.pipeline.runNow(row.id, {
        ...(req.body.dryRun !== undefined ? { dryRun: req.body.dryRun } : {}),
        ...(req.body.batchId !== undefined ? { batchId: req.body.batchId } : {}),
        actor: actorOf(req),
        reason,
      });
      return result;
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/processes/:id/breaker/reset',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      await ctx.pipeline.resetBreaker(req.params.id, actorOf(req), reason);
      return processDetail(ctx, req.params.id);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/processes/:id/versions',
    viewer,
    async (req): Promise<ProcessVersionSummary[]> => {
      const rows = await db
        .select({
          version: processVersions.version,
          savedBy: processVersions.savedBy,
          savedAt: processVersions.savedAt,
          reason: processVersions.reason,
        })
        .from(processVersions)
        .where(eq(processVersions.processId, req.params.id))
        .orderBy(desc(processVersions.version));
      return rows.map((r) => ({ ...r, savedAt: r.savedAt.toISOString() }));
    },
  );

  app.get<{ Params: { id: string; version: string } }>(
    '/api/v1/processes/:id/versions/:version',
    viewer,
    async (req): Promise<ProcessVersionDetail> => {
      const [row] = await db
        .select()
        .from(processVersions)
        .where(
          and(
            eq(processVersions.processId, req.params.id),
            eq(processVersions.version, Number(req.params.version)),
          ),
        );
      if (!row) throw notFound('Version');
      return {
        version: row.version,
        savedBy: row.savedBy,
        savedAt: row.savedAt.toISOString(),
        reason: row.reason,
        document: row.document,
      };
    },
  );

  app.post<{ Params: { id: string; version: string }; Body: { reason: string } }>(
    '/api/v1/processes/:id/versions/:version/restore',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const [old] = await db
        .select()
        .from(processVersions)
        .where(
          and(
            eq(processVersions.processId, req.params.id),
            eq(processVersions.version, Number(req.params.version)),
          ),
        );
      if (!old) throw notFound('Version');
      const doc = await validateProcessDocument(ctx, old.document);
      const now = clock.now();
      const actor = actorOf(req);
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(processes)
          .where(eq(processes.id, req.params.id))
          .for('update');
        if (!before) throw notFound('Process');
        const version = before.version + 1;
        await tx
          .update(processes)
          .set({ name: doc.name, document: doc, enabled: doc.enabled, version, updatedAt: now })
          .where(eq(processes.id, before.id));
        await tx.insert(processVersions).values({
          processId: before.id,
          version,
          document: doc,
          savedBy: actor,
          savedAt: now,
          reason: `restore v${old.version}: ${reason}`,
        });
        await recordAudit(tx, {
          actor,
          scope: 'process',
          targetId: before.id,
          field: 'restored',
          before: before.version,
          after: old.version,
          reason,
          at: now,
        });
      });
      return processDetail(ctx, req.params.id);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/v1/processes/:id/batches',
    viewer,
    async (req): Promise<RecentBatchDTO[]> => {
      const rows = await db
        .select()
        .from(batches)
        .where(
          and(
            eq(batches.processId, req.params.id),
            inArray(batches.kind, ['event', 'sweep', 'manual']),
          ),
        )
        .orderBy(desc(batches.openedAt))
        .limit(Math.min(Number(req.query.limit ?? 20) || 20, 100));
      const arts = await batchArtifacts(
        ctx,
        rows.map((r) => r.id),
      );
      return rows.map((b) => ({
        id: b.id,
        kind: b.kind,
        openedAt: b.openedAt.toISOString(),
        size: b.size,
        outcome: b.outcome,
        artifacts: arts.get(b.id)?.artifacts ?? [],
      }));
    },
  );

  app.post<{ Body: FilterPreviewRequest }>(
    '/api/v1/processes/preview/filter',
    viewer,
    async (req) => ctx.preview.filterPreview(req.body),
  );
  app.post<{ Body: InputPreviewRequest }>('/api/v1/processes/preview/input', viewer, async (req) =>
    ctx.preview.inputPreview(req.body),
  );
  app.post<{ Body: CronPreviewRequest }>('/api/v1/processes/preview/cron', viewer, (req) =>
    ctx.preview.cronPreview(req.body),
  );
}

/** One level of dotted keys so the audit log reads `gates.approval: none → always`. */
function flatten(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) out[`${k}.${k2}`] = v2;
    } else {
      out[k] = v;
    }
  }
  return out;
}
