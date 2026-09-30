import type { StatusTone, TraceEntry, TraceEntryKind } from '../contract/index.js';
import type {
  approvals,
  batches,
  dispatches,
  events,
  notificationLog,
  runUpdates,
  runs,
  steps,
  GateDecisionRecord,
} from '../db/schema.js';
import { EVENT_STAGE_LABELS } from '../domain/labels.js';
import {
  isTerminalRunStatus,
  stepTone,
  type EventStage,
  type RunStatusValue,
  type StepStatus,
} from '../domain/status.js';
import { neverInvoked } from '../pipeline/counted.js';
import { DEDUPE_WINDOW_DAYS } from '../pipeline/dedupe.js';

import type { Explanation } from './explain.js';

/** Every row an artifact's trace is drawn from. */
export interface TraceData {
  events: (typeof events.$inferSelect)[];
  dispatches: (typeof dispatches.$inferSelect)[];
  batches: (typeof batches.$inferSelect)[];
  runs: (typeof runs.$inferSelect)[];
  updates: (typeof runUpdates.$inferSelect)[];
  steps: (typeof steps.$inferSelect)[];
  approvals: (typeof approvals.$inferSelect)[];
  notifications: (typeof notificationLog.$inferSelect)[];
  processNames: ReadonlyMap<string, string>;
  destinationNames: ReadonlyMap<string, string>;
  /** Why each event did not reach a process, by event id. */
  explanations: ReadonlyMap<string, Explanation[]>;
}

const STEP_TITLE: Record<StepStatus, string> = {
  started: 'started (in progress, or in doubt if the run moved on)',
  ok: 'ok',
  error: 'error',
  skipped: 'skipped',
  uncertain: 'uncertain (in doubt, not repeated)',
};

const NOTE_SUFFIX: Record<'sending' | 'sent' | 'error', string> = {
  sending: ': claimed, delivery not confirmed',
  sent: '',
  error: ': failed',
};

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

export function stageTone(stage: EventStage): StatusTone {
  return EVENT_STAGE_LABELS[stage].tone;
}

export function runTone(status: RunStatusValue): StatusTone {
  switch (status) {
    case 'ok':
    case 'invoking':
    case 'running':
      return 'ok';
    case 'error':
    case 'failed':
    case 'unknown':
      return 'error';
    case 'held':
    case 'uncertain':
      return 'warn';
  }
}

const iso = (d: Date) => d.toISOString();

interface Named {
  processId: string;
  processName: string;
}

function eventEntries(d: TraceData, pn: (id: string) => Named): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const e of d.events) {
    out.push({
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
    // Skips are summarised by the explanation entries below, not listed one by one.
    for (const m of e.matchDecisions.filter((x) => x.skip === undefined)) {
      out.push({
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
  return out;
}

function explanationEntries(d: TraceData): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const e of d.events) {
    const list = d.explanations.get(e.id) ?? [];
    const at = e.matchDecisions[0]?.at ?? iso(e.receivedAt);
    if (list.length === 0 && e.stage === 'unmatched') {
      out.push({
        at,
        kind: 'filter',
        tone: 'off',
        title: 'Nothing ran: no process has a trigger on this source',
        eventId: e.id,
      });
    }
    for (const x of list) {
      if (x.taken) continue;
      out.push({
        at,
        kind: 'filter',
        tone: x.tone === 'warn' ? 'warn' : 'off',
        title: `${x.processName} did not take it: ${x.reason}`,
        ...(x.basis === 'now'
          ? {
              detail:
                'Explained from the configuration as it is now: nothing was recorded for this process when the event arrived.',
            }
          : {}),
        data: { taken: false, reason: x.reason, basis: x.basis },
        eventId: e.id,
        processId: x.processId,
        processName: x.processName,
      });
    }
  }
  return out;
}

function dispatchEntries(d: TraceData, pn: (id: string) => Named): TraceEntry[] {
  const out: TraceEntry[] = [];
  const batchById = new Map(d.batches.map((b) => [b.id, b]));
  const firstDispatch = new Map<string, string>();
  for (const x of [...d.dispatches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (x.batchId && !firstDispatch.has(x.batchId)) firstDispatch.set(x.batchId, x.id);
  }
  for (const x of d.dispatches) {
    if (x.outcome === 'deduped') {
      out.push({
        at: iso(x.createdAt),
        kind: 'dedupe',
        tone: 'off',
        title: `Deduped: this change was already dispatched to the process in the last ${DEDUPE_WINDOW_DAYS} days`,
        data: { dedupeKey: x.dedupeKey },
        eventId: x.eventId,
        ...pn(x.processId),
      });
    } else if (x.outcome === 'batched' && x.batchId && firstDispatch.get(x.batchId) !== x.id) {
      const b = batchById.get(x.batchId);
      out.push({
        at: iso(x.createdAt),
        kind: 'batch_join',
        tone: 'ok',
        title: `Joined batch${b?.batchKey ? ` ${b.batchKey}` : ''}`,
        eventId: x.eventId,
        batchId: x.batchId,
        ...pn(x.processId),
      });
    }
  }
  return out;
}

export function decisionEntry(
  r: GateDecisionRecord,
  batchId: string,
  batchKind: string,
  proc: Named,
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

function approvalEntries(d: TraceData, pn: (id: string) => Named): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const a of d.approvals) {
    out.push({
      at: iso(a.requestedAt),
      kind: 'approval',
      tone: 'warn',
      title: `Awaiting approval (${a.rule})`,
      ...(a.input !== null ? { data: { input: a.input } } : {}),
      batchId: a.batchId,
      ...pn(a.processId),
    });
    if (a.decidedAt && a.decision) {
      out.push({
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
  return out;
}

function runEntries(d: TraceData, pn: (id: string) => Named): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const r of d.runs) {
    const base = { batchId: r.batchId, runId: r.id, ...pn(r.processId) };
    if (r.invokedAt && !neverInvoked(r)) {
      out.push({
        at: iso(r.invokedAt),
        kind: 'invoke',
        tone: 'ok',
        title: `Invoked ${d.destinationNames.get(r.destinationId) ?? r.destinationId}${r.dryRun ? ' (dry run)' : ''}`,
        data: { input: r.input, attempts: r.attempts, externalId: r.externalId },
        ...base,
        ...(r.externalUrl ? { externalUrl: r.externalUrl } : {}),
      });
    }
    const terminalLogged = d.updates.some((u) => u.runId === r.id && isTerminalRunStatus(u.status));
    if (!terminalLogged && r.finishedAt) {
      out.push({
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
  const runById = new Map(d.runs.map((r) => [r.id, r]));
  for (const u of d.updates) {
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
    out.push({
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
  for (const s of d.steps) {
    const r = runById.get(s.runId);
    out.push({
      at: iso(s.at),
      kind: 'step',
      tone: stepTone(s.status),
      title: `${s.phase} step ${s.action} on ${s.providerId}: ${STEP_TITLE[s.status]}`,
      ...(s.error ? { detail: s.error } : {}),
      data: { args: s.args },
      runId: s.runId,
      ...(r ? { batchId: r.batchId, ...pn(r.processId) } : {}),
    });
  }
  return out;
}

function notificationEntries(d: TraceData, pn: (id: string) => Named): TraceEntry[] {
  return d.notifications.map((n) => ({
    at: iso(n.at),
    kind: 'notification',
    tone: n.status === 'sent' ? 'ok' : n.status === 'sending' ? 'warn' : 'error',
    title: `Notified ${n.notifierId} (${n.on})${NOTE_SUFFIX[n.status]}`,
    detail: n.error ?? n.text.slice(0, 200),
    ...(n.batchId ? { batchId: n.batchId } : {}),
    ...(n.runId ? { runId: n.runId } : {}),
    ...(n.processId ? pn(n.processId) : {}),
  }));
}

/** Every step of the trace, oldest first; at the same moment, in pipeline order. */
export function traceEntries(d: TraceData): TraceEntry[] {
  const pn = (id: string): Named => ({ processId: id, processName: d.processNames.get(id) ?? id });
  const entries = [
    ...eventEntries(d, pn),
    ...explanationEntries(d),
    ...dispatchEntries(d, pn),
    ...d.batches.flatMap((b) =>
      b.decisions.map((r) => decisionEntry(r, b.id, b.kind, pn(b.processId))),
    ),
    ...approvalEntries(d, pn),
    ...runEntries(d, pn),
    ...notificationEntries(d, pn),
  ];
  return entries.sort((a, b) => {
    const t = Date.parse(a.at) - Date.parse(b.at);
    return t !== 0 ? t : KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  });
}

export function renderTraceText(query: string, entries: readonly TraceEntry[]): string {
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
