import { desc, eq, inArray, or, sql } from 'drizzle-orm';

import type { ArtifactRef } from '@ai-switchboard/sdk';

import type { StatusTone, TraceEntry, TraceEntryKind, TraceResponse } from '../api/contract.js';
import {
  approvals,
  batches,
  dispatches,
  events,
  executors,
  notificationLog,
  processes,
  runUpdates,
  runs,
  steps,
  type GateDecisionRecord,
} from '../db/schema.js';
import type { Deps } from '../deps.js';
import { isTerminalRunStatus, type EventStage, type RunStatusValue } from '../domain/status.js';

import { isUuid } from './pipeline/errors.js';
import { relatedBatchIds } from './pipeline/load.js';

/**
 * The trace: every event, filter decision, dedupe, batch open/join/close, gate check, budget
 * check (binding limit, counters and meter readings at that moment), approval, step, invoke,
 * tracking update, terminal state and notification for an artifact (or one event), as one
 * vertical timeline sorted by time, plus the same timeline as copyable text.
 */

type EventRow = typeof events.$inferSelect;

const MAX_EVENTS = 200;

const KIND_ORDER: TraceEntryKind[] = [
  'event',
  'filter',
  'dedupe',
  'batch_open',
  'batch_join',
  'batch_close',
  'gate',
  'budget',
  'approval',
  'step',
  'invoke',
  'tracking',
  'terminal',
  'notification',
];

function stageTone(stage: EventStage): StatusTone {
  switch (stage) {
    case 'received':
    case 'matched':
      return 'ok';
    case 'unmatched':
    case 'source_disabled':
    case 'type_muted':
      return 'off';
    case 'source_throttled':
      return 'warn';
    case 'event_invalid':
      return 'error';
  }
}

function runTone(status: RunStatusValue): StatusTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'error':
    case 'failed':
    case 'unknown':
      return 'error';
    case 'held':
    case 'uncertain':
      return 'warn';
    case 'invoking':
    case 'running':
      return 'ok';
  }
}

const iso = (d: Date) => d.toISOString();

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Events for a query: an event id, an exact artifact id, `kind:id`, or an id suffix (`#482`). */
async function findEvents(deps: Deps, query: string): Promise<EventRow[]> {
  const q = query.trim();
  if (q === '') return [];
  if (isUuid(q)) {
    const byId = await deps.db.select().from(events).where(eq(events.id, q));
    if (byId.length > 0) return byId;
  }
  const idExpr = sql`(${events.artifact}->>'id')`;
  const suffixes = [q];
  if (/^\d+$/.test(q)) suffixes.push(`#${q}`, `/${q}`);
  const conditions = [
    sql`${idExpr} = ${q}`,
    eq(events.artifactKey, q),
    ...suffixes.map((s) => sql`${idExpr} LIKE ${`%${likeEscape(s)}`}`),
  ];
  if (q.startsWith('#')) conditions.push(sql`${idExpr} = ${q.slice(1)}`);
  return deps.db
    .select()
    .from(events)
    .where(or(...conditions))
    .orderBy(desc(events.receivedAt))
    .limit(MAX_EVENTS);
}

export async function traceForArtifact(deps: Deps, query: string): Promise<TraceResponse> {
  const rows = await findEvents(deps, query);
  return buildTrace(deps, query, rows);
}

export async function traceForEvent(deps: Deps, eventId: string): Promise<TraceResponse> {
  const rows = isUuid(eventId)
    ? await deps.db.select().from(events).where(eq(events.id, eventId))
    : [];
  return buildTrace(deps, eventId, rows);
}

async function buildTrace(
  deps: Deps,
  query: string,
  eventRows: EventRow[],
): Promise<TraceResponse> {
  const entries: TraceEntry[] = [];
  const artifacts = new Map<string, ArtifactRef>();
  for (const e of eventRows) artifacts.set(e.artifactKey, e.artifact);
  const eventIds = eventRows.map((e) => e.id);
  if (eventIds.length === 0)
    return { query, artifacts: [], entries: [], text: `No events found for ${query}.` };

  const disp = await deps.db.select().from(dispatches).where(inArray(dispatches.eventId, eventIds));
  const directBatches = [
    ...new Set(disp.map((d) => d.batchId).filter((b): b is string => b !== null)),
  ];
  const batchIds = await relatedBatchIds(deps.db, directBatches);
  const batchRows =
    batchIds.length > 0
      ? await deps.db.select().from(batches).where(inArray(batches.id, batchIds))
      : [];
  const runRows =
    batchIds.length > 0
      ? await deps.db.select().from(runs).where(inArray(runs.batchId, batchIds))
      : [];
  const runIds = runRows.map((r) => r.id);
  const updates =
    runIds.length > 0
      ? await deps.db.select().from(runUpdates).where(inArray(runUpdates.runId, runIds))
      : [];
  const stepRows =
    runIds.length > 0 ? await deps.db.select().from(steps).where(inArray(steps.runId, runIds)) : [];
  const approvalRows =
    batchIds.length > 0
      ? await deps.db.select().from(approvals).where(inArray(approvals.batchId, batchIds))
      : [];
  const notes =
    batchIds.length > 0
      ? await deps.db
          .select()
          .from(notificationLog)
          .where(
            or(
              inArray(notificationLog.batchId, batchIds),
              ...(runIds.length > 0 ? [inArray(notificationLog.runId, runIds)] : []),
            ),
          )
      : [];
  const processIds = [
    ...new Set([
      ...disp.map((d) => d.processId),
      ...batchRows.map((b) => b.processId),
      ...eventRows.flatMap((e) => e.matchDecisions.map((m) => m.processId)),
    ]),
  ];
  const procRows =
    processIds.length > 0
      ? await deps.db
          .select({ id: processes.id, name: processes.name })
          .from(processes)
          .where(inArray(processes.id, processIds))
      : [];
  const procName = new Map(procRows.map((p) => [p.id, p.name]));
  const exIds = [...new Set(runRows.map((r) => r.executorId))];
  const exRows =
    exIds.length > 0
      ? await deps.db
          .select({ id: executors.id, name: executors.name })
          .from(executors)
          .where(inArray(executors.id, exIds))
      : [];
  const exName = new Map(exRows.map((e) => [e.id, e.name]));
  const pn = (id: string) => ({ processId: id, processName: procName.get(id) ?? id });

  for (const e of eventRows) {
    entries.push({
      at: iso(e.receivedAt),
      kind: 'event',
      tone: stageTone(e.stage),
      title: `${e.type} on ${e.artifact.kind} ${e.artifact.id}${e.replayOf ? ' (replay)' : ''}: ${e.stage}`,
      ...(e.stageReason ? { detail: e.stageReason } : {}),
      data: {
        stage: e.stage,
        occurredAt: iso(e.occurredAt),
        attributes: e.attributes,
        dedupeKey: e.dedupeKey,
        deliveryId: e.deliveryId,
        replayOf: e.replayOf,
      },
      eventId: e.id,
      ...(e.artifact.url ? { externalUrl: e.artifact.url } : {}),
    });
    for (const m of e.matchDecisions) {
      entries.push({
        at: m.at,
        kind: 'filter',
        tone: m.error !== undefined && !m.result ? 'error' : m.result ? 'ok' : 'off',
        title: `Filter ${m.result ? 'matched' : m.error !== undefined ? 'failed (counts as false)' : 'did not match'}`,
        ...(m.error !== undefined ? { detail: m.error } : {}),
        data: {
          expr: m.expr ?? null,
          result: m.result,
          triggerId: m.triggerId,
          batchKey: m.batchKey ?? null,
        },
        eventId: e.id,
        ...pn(m.processId),
      });
    }
  }

  const batchById = new Map(batchRows.map((b) => [b.id, b]));
  const firstDispatch = new Map<string, string>();
  for (const d of [...disp].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (d.batchId && !firstDispatch.has(d.batchId)) firstDispatch.set(d.batchId, d.id);
  }
  for (const d of disp) {
    if (d.outcome === 'deduped') {
      entries.push({
        at: iso(d.createdAt),
        kind: 'dedupe',
        tone: 'off',
        title: 'Deduped: this change was already dispatched to the process in the last 7 days',
        data: { dedupeKey: d.dedupeKey },
        eventId: d.eventId,
        ...pn(d.processId),
      });
    } else if (d.outcome === 'batched' && d.batchId && firstDispatch.get(d.batchId) !== d.id) {
      const b = batchById.get(d.batchId);
      entries.push({
        at: iso(d.createdAt),
        kind: 'batch_join',
        tone: 'ok',
        title: `Joined batch${b?.batchKey ? ` ${b.batchKey}` : ''}`,
        eventId: d.eventId,
        batchId: d.batchId,
        ...pn(d.processId),
      });
    }
  }

  for (const b of batchRows) {
    for (const r of b.decisions) entries.push(decisionEntry(r, b.id, b.kind, pn(b.processId)));
  }

  for (const a of approvalRows) {
    entries.push({
      at: iso(a.requestedAt),
      kind: 'approval',
      tone: 'warn',
      title: `Awaiting approval (${a.rule})`,
      ...(a.input !== null ? { data: { input: a.input } } : {}),
      batchId: a.batchId,
      ...pn(a.processId),
    });
    if (a.decidedAt && a.decision) {
      entries.push({
        at: iso(a.decidedAt),
        kind: 'approval',
        tone: a.decision === 'approved' ? 'ok' : 'off',
        title: `${a.decision === 'approved' ? 'Approved' : 'Rejected'} by ${a.decidedBy ?? 'unknown'}`,
        ...(a.reason ? { detail: a.reason } : {}),
        batchId: a.batchId,
        ...pn(a.processId),
      });
    }
  }

  for (const r of runRows) {
    const base = { batchId: r.batchId, runId: r.id, ...pn(r.processId) };
    if (r.invokedAt && !(r.status === 'failed' && r.attempts === 0)) {
      entries.push({
        at: iso(r.invokedAt),
        kind: 'invoke',
        tone: 'ok',
        title: `Invoked ${exName.get(r.executorId) ?? r.executorId}${r.dryRun ? ' (dry run)' : ''}`,
        data: { input: r.input, attempts: r.attempts, externalId: r.externalId },
        ...base,
        ...(r.externalUrl ? { externalUrl: r.externalUrl } : {}),
      });
    }
    const terminalLogged = updates.some((u) => u.runId === r.id && isTerminalRunStatus(u.status));
    if (!terminalLogged && r.finishedAt) {
      entries.push({
        at: iso(r.finishedAt),
        kind: 'terminal',
        tone: runTone(r.status),
        title: `Run ${r.status}`,
        ...(r.statusReason ? { detail: r.statusReason } : {}),
        data: { errors: r.errors ?? [], usage: r.usage },
        ...base,
      });
    }
  }
  const runById = new Map(runRows.map((r) => [r.id, r]));
  for (const u of updates) {
    const r = runById.get(u.runId);
    if (!r) continue;
    const terminal = isTerminalRunStatus(u.status);
    const detail = u.detail as Record<string, unknown> | null;
    const url =
      typeof detail?.externalUrl === 'string'
        ? detail.externalUrl
        : terminal
          ? r.externalUrl
          : null;
    entries.push({
      at: iso(u.at),
      kind: terminal ? 'terminal' : 'tracking',
      tone: runTone(u.status),
      title: terminal ? `Run ${u.status} (${u.source})` : `${u.source}: ${u.status}`,
      ...(typeof detail?.reason === 'string' ? { detail: detail.reason } : {}),
      data: { ...(detail ?? {}), ...(terminal ? { usage: r.usage, errors: r.errors ?? [] } : {}) },
      batchId: r.batchId,
      runId: r.id,
      ...pn(r.processId),
      ...(url ? { externalUrl: url } : {}),
    });
  }
  for (const s of stepRows) {
    const r = runById.get(s.runId);
    entries.push({
      at: iso(s.at),
      kind: 'step',
      tone: s.status === 'ok' ? 'ok' : s.status === 'error' ? 'error' : 'off',
      title: `${s.phase} step ${s.action} on ${s.providerId}: ${s.status}`,
      ...(s.error ? { detail: s.error } : {}),
      data: { args: s.args },
      runId: s.runId,
      ...(r ? { batchId: r.batchId, ...pn(r.processId) } : {}),
    });
  }
  for (const n of notes) {
    entries.push({
      at: iso(n.at),
      kind: 'notification',
      tone: n.status === 'sent' ? 'ok' : 'error',
      title: `Notified ${n.notifierId} (${n.on})${n.status === 'error' ? ': failed' : ''}`,
      detail: n.error ?? n.text.slice(0, 200),
      ...(n.batchId ? { batchId: n.batchId } : {}),
      ...(n.runId ? { runId: n.runId } : {}),
      ...(n.processId ? pn(n.processId) : {}),
    });
  }

  entries.sort((a, b) => {
    const t = Date.parse(a.at) - Date.parse(b.at);
    return t !== 0 ? t : KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  });
  return { query, artifacts: [...artifacts.values()], entries, text: renderText(query, entries) };
}

function decisionEntry(
  r: GateDecisionRecord,
  batchId: string,
  batchKind: string,
  proc: { processId: string; processName: string },
): TraceEntry {
  const base = { at: r.at, batchId, ...proc };
  const detail = r.detail !== undefined ? { detail: r.detail } : {};
  if (r.stage === 'batch') {
    const kind: TraceEntryKind =
      r.check === 'close' || r.check === 'merged' ? 'batch_close' : 'batch_open';
    const title =
      r.check === 'open'
        ? 'Batch opened'
        : r.check === 'close'
          ? `Batch closed (${r.detail ?? 'debounce'})`
          : r.check === 'merged'
            ? 'Batch merged into a sweep'
            : r.check === 'sweep'
              ? 'Sweep fired'
              : `Manual ${batchKind} batch`;
    return { ...base, kind, tone: 'ok', title, ...(r.check !== 'close' ? detail : {}) };
  }
  if (r.stage === 'approval') {
    return {
      ...base,
      kind: 'approval',
      tone: r.pass ? 'ok' : 'off',
      title: `Approval ${r.check}`,
      ...detail,
    };
  }
  if (r.stage === 'gate') {
    return {
      ...base,
      kind: 'gate',
      tone: r.pass ? 'ok' : 'warn',
      title: `Gate ${r.check}: ${r.pass ? 'pass' : 'held'}`,
      ...detail,
    };
  }
  const binding = typeof r.data?.binding === 'string' ? r.data.binding : null;
  return {
    ...base,
    kind: 'budget',
    tone: r.pass ? 'ok' : r.check === 'input' ? 'error' : 'warn',
    title:
      r.check === 'input'
        ? 'Input mapping failed validation (no budget spent)'
        : r.pass
          ? 'Budget: within limits'
          : `Throttled: ${binding ?? 'budget'}`,
    ...detail,
    ...(r.data ? { data: r.data } : {}),
  };
}

function renderText(query: string, entries: readonly TraceEntry[]): string {
  const lines = [`Trace for ${query}`];
  for (const e of entries) {
    const parts = [e.at, e.kind.padEnd(12), e.title];
    if (e.processName) parts.push(`[${e.processName}]`);
    let line = parts.join('  ');
    if (e.detail) line += ` — ${e.detail}`;
    if (e.externalUrl) line += ` <${e.externalUrl}>`;
    if (e.kind === 'filter' && typeof e.data?.expr === 'string')
      line += `\n${' '.repeat(26)}filter: ${e.data.expr}`;
    lines.push(line);
  }
  return lines.join('\n');
}
