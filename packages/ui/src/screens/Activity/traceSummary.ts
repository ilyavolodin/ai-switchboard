import type {
  StageIndicator,
  StatusTone,
  TraceEntry,
  TraceEntryKind,
} from '@ai-switchboard/core/contract';

import { isWhyEntry } from '../../lib/why.js';

export const EXPANDED_KINDS: readonly TraceEntryKind[] = ['filter', 'gate', 'budget', 'approval'];

export const QUERY_FORMS = [
  { example: 'LOL-1712', help: 'an artifact id as the system shows it' },
  { example: '#482', help: 'a GitHub pull request or issue number' },
  { example: 'linear.issue:LOL-1712', help: 'kind:id, when the same id exists in two systems' },
];

export const TOUCH_WORD: Record<StatusTone, string> = {
  ok: 'run ok',
  warn: 'held or throttled',
  error: 'run error',
  off: 'no run',
};

export interface TraceSummary {
  events: number;
  processes: { id: string; name: string; tone: StatusTone }[];
  runs: number;
  ok: number;
  errors: number;
}

export function summarizeTrace(entries: TraceEntry[]): TraceSummary {
  const events = new Set<string>();
  const runs = new Set<string>();
  const processes = new Map<string, { id: string; name: string; tone: StatusTone }>();
  // Runs remember their process so a terminal entry (which may carry only a run id) colours it.
  const runProcess = new Map<string, string>();
  let lastProcess: string | null = null;
  let ok = 0;
  let errors = 0;
  for (const e of entries) {
    if (e.eventId && (e.kind === 'event' || e.kind === 'batch_join')) events.add(e.eventId);
    // A process that did not take the event did not touch it; "Why nothing ran" lists it.
    if (isWhyEntry(e)) continue;
    if (e.processId) {
      lastProcess = e.processId;
      const known = processes.get(e.processId);
      processes.set(e.processId, {
        id: e.processId,
        name: e.processName ?? known?.name ?? e.processId,
        tone: known?.tone ?? 'off',
      });
    }
    if (e.runId) {
      runs.add(e.runId);
      if (e.processId) runProcess.set(e.runId, e.processId);
      else if (lastProcess && !runProcess.has(e.runId)) runProcess.set(e.runId, lastProcess);
    }
    if (e.kind === 'terminal') {
      if (e.tone === 'ok') ok += 1;
      if (e.tone === 'error') errors += 1;
      const pid = (e.runId && runProcess.get(e.runId)) ?? e.processId ?? lastProcess;
      const p = pid ? processes.get(pid) : undefined;
      if (p) p.tone = e.tone;
    } else if (e.processId && (e.tone === 'warn' || e.tone === 'error')) {
      const p = processes.get(e.processId);
      if (p) p.tone = e.tone;
    }
  }
  return { events: events.size, processes: [...processes.values()], runs: runs.size, ok, errors };
}

const REACHED: Partial<Record<TraceEntryKind, 1 | 2 | 3 | 4 | 5>> = {
  event: 1,
  filter: 2,
  dedupe: 2,
  batch_open: 3,
  batch_join: 3,
  batch_close: 3,
  gate: 4,
  budget: 4,
  approval: 4,
  invoke: 5,
  step: 5,
  tracking: 5,
  terminal: 5,
};

const STOPS = [0, 1, 2, 3, 4, 5] as const;

export function traceStage(entries: TraceEntry[]): StageIndicator {
  let reached: StageIndicator['reached'] = 0;
  for (const e of entries) {
    // "Did not take it" stops the event at received, whatever its tone.
    const r = isWhyEntry(e) ? 1 : REACHED[e.kind];
    if (r == null) continue;
    // A check that stopped the batch leaves it at the stop before the one it guards.
    const stopped = (e.tone === 'warn' || e.tone === 'error') && r < 5;
    const stop = STOPS[stopped ? r - 1 : r] ?? 0;
    if (stop > reached) reached = stop;
  }
  const last = entries[entries.length - 1];
  return {
    reached,
    tone: last?.tone ?? 'off',
    label: last ? last.title.toLowerCase() : 'nothing recorded',
  };
}
