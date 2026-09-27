import type { JSONSchema, RunStatus, UsageReport } from '@ai-switchboard/sdk';

import { OS_KEYS, osDimension } from './settings.js';
import { tryParse } from './validate.js';

/** The fields of a GitHub workflow run the executor reads. */
export interface WorkflowRun {
  id: number;
  name?: string | null;
  display_title?: string | null;
  status: string | null;
  conclusion: string | null;
  html_url?: string;
  run_started_at?: string | null;
  updated_at?: string;
  created_at?: string;
}

export const workflowRunSchema: JSONSchema = {
  type: 'object',
  required: ['id', 'status'],
  properties: {
    id: { type: 'integer' },
    name: { type: ['string', 'null'] },
    display_title: { type: ['string', 'null'] },
    status: { type: ['string', 'null'] },
    conclusion: { type: ['string', 'null'] },
    html_url: { type: 'string' },
    run_started_at: { type: ['string', 'null'] },
    updated_at: { type: 'string' },
  },
};

export const runListSchema: JSONSchema = {
  type: 'object',
  required: ['workflow_runs'],
  properties: { workflow_runs: { type: 'array', items: workflowRunSchema } },
};

/** Where a dispatched run lives. Encoded into `externalId` so `poll` needs no target. */
export interface RunRef {
  owner: string;
  repo: string;
  runId: number;
}

export function encodeRef(ref: RunRef): string {
  return `${ref.owner}/${ref.repo}/${ref.runId}`;
}

export function decodeRef(externalId: string | undefined): RunRef | undefined {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(\d+)$/.exec(externalId ?? '');
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { owner: match[1], repo: match[2], runId: Number(match[3]) };
}

/** A run is ours when its name (set by `run-name: ${{ inputs.switchboard_run_id }}`) carries the run id. */
export function matchesRun(run: WorkflowRun, switchboardRunId: string): boolean {
  return [run.name, run.display_title].some(
    (s) => typeof s === 'string' && s.includes(switchboardRunId),
  );
}

const SUCCESS = new Set(['success', 'neutral', 'skipped']);

/** Map GitHub's status/conclusion to a run state. */
export function stateOf(run: WorkflowRun): RunStatus['state'] {
  if (run.status !== 'completed') return 'running';
  return run.conclusion !== null && SUCCESS.has(run.conclusion) ? 'ok' : 'error';
}

interface Timing {
  billable?: Partial<
    Record<string, { total_ms?: number; jobs?: number; job_runs?: { duration_ms: number }[] }>
  >;
  run_duration_ms?: number;
}

const timingSchema: JSONSchema = {
  type: 'object',
  properties: {
    billable: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          total_ms: { type: 'number', minimum: 0 },
          jobs: { type: 'integer', minimum: 0 },
          job_runs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['duration_ms'],
              properties: { duration_ms: { type: 'number', minimum: 0 } },
            },
          },
        },
      },
    },
    run_duration_ms: { type: 'number', minimum: 0 },
  },
};

const MINUTE_MS = 60_000;

/**
 * Billable minutes per runner OS from the run's timing. GitHub rounds each job up to the whole
 * minute, so per-job durations are rounded individually when present. No OS multipliers are
 * applied: these are the minutes GitHub lists, not included-minute consumption.
 */
export function usageFromTiming(timing: unknown): UsageReport {
  const parsed = tryParse<Timing>(timingSchema, timing);
  if (!parsed) return {};
  const usage: UsageReport = {};
  if (parsed.billable) {
    let total = 0;
    for (const os of OS_KEYS) {
      const entry = parsed.billable[os];
      if (!entry) continue;
      const minutes = entry.job_runs
        ? entry.job_runs.reduce((sum, job) => sum + Math.ceil(job.duration_ms / MINUTE_MS), 0)
        : Math.ceil((entry.total_ms ?? 0) / MINUTE_MS);
      usage[osDimension(os)] = minutes;
      total += minutes;
    }
    usage.billable_minutes = total;
  }
  if (parsed.run_duration_ms !== undefined) {
    usage.duration_seconds = parsed.run_duration_ms / 1000;
  }
  return usage;
}

/** Fallback when the timing endpoint has no `run_duration_ms`. */
export function durationFromRun(run: WorkflowRun): number | undefined {
  if (!run.run_started_at || !run.updated_at) return undefined;
  const ms = Date.parse(run.updated_at) - Date.parse(run.run_started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : undefined;
}
