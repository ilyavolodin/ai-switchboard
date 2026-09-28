import { validateAgainst } from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import jsonata from 'jsonata';

import { actorOf, requireRole } from '../../auth/fastify.js';
import { destinations, notifiers, sources } from '../../db/schema.js';
import { processDocumentSchema, type ProcessDocument } from '../../domain/process.js';
import {
  createProcess,
  deleteProcess,
  saveProcessVersion,
  type SaveMeta,
} from '../../services/processes.js';
import type { DbOrTx } from '../../db/client.js';
import type { ApiContext } from '../context.js';
import type {
  CreateProcessRequest,
  CronPreviewRequest,
  EnableRequest,
  FilterPreviewRequest,
  InputPreviewRequest,
  RunNowRequest,
  UpdateProcessRequest,
} from '../contract.js';
import { badRequest, conflict, HttpError, notFound, requireReason } from '../errors.js';
import {
  processDetail,
  processExists,
  processSummaries,
  processVersion,
  processVersionList,
  recentBatches,
} from '../read/processes.js';

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
 * declared by the source, the target matches the destination's targetSchema, expressions compile,
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

  const [ex] = await db
    .select()
    .from(destinations)
    .where(eq(destinations.id, doc.destination.instanceId));
  if (!ex) {
    problems.push('destination.instanceId references a destination that does not exist');
  } else {
    const type = ctx.runtime.destinationType(ex.typeId)?.type;
    if (type) {
      const target = {
        ...ex.targetDefaults,
        ...(doc.destination.target as Record<string, unknown>),
      };
      const t = validateAgainst(type.targetSchema, target);
      if (!t.valid)
        problems.push(
          ...t.errors.map(
            (e) => `destination.target${e.startsWith('(root)') ? e.slice(6) : ` ${e}`}`,
          ),
        );
    }
    const live = ctx.runtime.destination(ex.id);
    // A destination created in the same apply has no live object yet: ask the type about this
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

  const exRows = await db.select({ id: destinations.id }).from(destinations);
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
  const meta = (req: FastifyRequest, reason: string): SaveMeta => ({
    actor: actorOf(req),
    reason,
    now: clock.now(),
  });

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
      const id = await createProcess(db, doc, meta(req, reason));
      return reply.code(201).send(await processDetail(ctx, id));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateProcessRequest }>(
    '/api/v1/processes/:id',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const doc = await validateProcessDocument(ctx, req.body.document);
      const saved = await saveProcessVersion(db, req.params.id, meta(req, reason), (before) => {
        if (req.body.expectedVersion !== before.version) {
          throw conflict(
            `The process was changed by someone else (version ${before.version}); reload and reapply your edit.`,
          );
        }
        return { document: doc, audit: 'diff' };
      });
      if (!saved) throw notFound('Process');
      return processDetail(ctx, req.params.id);
    },
  );

  app.post<{ Params: { id: string }; Body: EnableRequest }>(
    '/api/v1/processes/:id/enable',
    { ...operator, schema: { body: enableBody } },
    async (req) => {
      const reason = requireReason(req.body);
      const { enabled } = req.body;
      const saved = await saveProcessVersion(db, req.params.id, meta(req, reason), (before) => ({
        document: { ...before.document, enabled },
        audit: { field: 'enabled', before: before.enabled, after: enabled },
      }));
      if (!saved) throw notFound('Process');
      return processDetail(ctx, req.params.id);
    },
  );

  app.delete<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/processes/:id',
    operator,
    async (req, reply) => {
      const reason = requireReason(req.body);
      const deleted = await deleteProcess(db, req.params.id, meta(req, reason));
      if (!deleted) throw notFound('Process');
      req.log.info(
        {
          process_id: req.params.id,
          dropped_batches: deleted.droppedBatches,
          withdrawn_approvals: deleted.withdrawnApprovals,
        },
        'process deleted',
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: RunNowRequest }>(
    '/api/v1/processes/:id/run',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      if (!(await processExists(ctx, req.params.id))) throw notFound('Process');
      return ctx.pipeline.runNow(req.params.id, {
        ...(req.body.dryRun !== undefined ? { dryRun: req.body.dryRun } : {}),
        ...(req.body.batchId !== undefined ? { batchId: req.body.batchId } : {}),
        actor: actorOf(req),
        reason,
      });
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

  app.get<{ Params: { id: string } }>('/api/v1/processes/:id/versions', viewer, async (req) =>
    processVersionList(ctx, req.params.id),
  );

  app.get<{ Params: { id: string; version: string } }>(
    '/api/v1/processes/:id/versions/:version',
    viewer,
    async (req) => processVersion(ctx, req.params.id, req.params.version),
  );

  app.post<{ Params: { id: string; version: string }; Body: { reason: string } }>(
    '/api/v1/processes/:id/versions/:version/restore',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      const old = await processVersion(ctx, req.params.id, req.params.version);
      const doc = await validateProcessDocument(ctx, old.document);
      const saved = await saveProcessVersion(db, req.params.id, meta(req, reason), (before) => ({
        document: doc,
        versionReason: `restore v${old.version}: ${reason}`,
        audit: { field: 'restored', before: before.version, after: old.version },
      }));
      if (!saved) throw notFound('Process');
      return processDetail(ctx, req.params.id);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/v1/processes/:id/batches',
    viewer,
    async (req) => recentBatches(ctx, req.params.id, req.query.limit),
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
