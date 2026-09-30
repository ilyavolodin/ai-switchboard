import {
  isRecord,
  validateAgainst,
  type InvokeResult,
  type JSONSchema,
  type RunStatus,
} from '@ai-switchboard/sdk';

import { TRACKING_STATES } from '../domain/status.js';

import { sourceNotes } from './door.js';

/** What a plugin returned, checked before the core relies on its shape. */
export type Checked<T> = { ok: true; value: T } | { ok: false; problem: string };

const stringList: JSONSchema = { type: 'array', items: { type: 'string' } };

const runStatusSchema: JSONSchema = {
  type: 'object',
  required: ['state'],
  properties: {
    state: { enum: [...TRACKING_STATES] },
    outputs: { type: 'number' },
    errors: stringList,
    usage: { type: 'object' },
    finishedAt: { type: 'string' },
    externalUrl: { type: 'string' },
  },
};

const invokeResultSchema: JSONSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    // Any string: `classifyInvoke` treats an unknown status as a lost response.
    status: { type: 'string' },
    externalId: { type: 'string' },
    externalUrl: { type: 'string' },
    reason: { type: 'string' },
    usage: { type: 'object' },
    retryAfterSeconds: { type: 'number' },
    errors: stringList,
  },
};

function check<T>(schema: JSONSchema, value: unknown, what: string): Checked<T> {
  const out = validateAgainst(schema, value);
  if (out.valid) return { ok: true, value: value as T };
  return { ok: false, problem: `${what} is malformed: ${out.errors.join('; ')}` };
}

/** A `poll` or `verifyCallback` status. */
export function checkRunStatus(value: unknown): Checked<RunStatus> {
  return check(runStatusSchema, value, 'RunStatus');
}

export function checkInvokeResult(value: unknown): Checked<InvokeResult> {
  return check(invokeResultSchema, value, 'InvokeResult');
}

export interface PolledPage {
  /** Checked one by one at the door, like pushed drafts. */
  drafts: unknown[];
  watermark: string | null;
  notes: string[];
}

/** A missing `events` list is an empty page; a missing watermark keeps the previous one. */
export function checkPollResult(value: unknown, previous: string | null): Checked<PolledPage> {
  if (!isRecord(value)) return { ok: false, problem: 'poll returned no result object' };
  return {
    ok: true,
    value: {
      drafts: Array.isArray(value.events) ? (value.events as unknown[]) : [],
      watermark: typeof value.watermark === 'string' ? value.watermark : previous,
      notes: sourceNotes(value.notes),
    },
  };
}
