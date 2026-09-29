import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { defaultProcessDocument } from '../domain/process.js';
import {
  processView,
  runView,
  toEvent,
  type EventRow,
  type ProcessRow,
  type RunRow,
} from '../services/pipeline/views.js';

import {
  EVENT_FIELDS,
  EXPRESSION_CONTEXTS,
  PROCESS_FIELDS,
  RUN_CONTEXT_FIELDS,
  RUN_FIELDS,
  SWITCHBOARD_FUNCTIONS,
  type ContextField,
} from './context-descriptors.js';
import {
  approvalContext,
  filterContext,
  mappingContext,
  stepContext,
  templateContext,
  type RunContext,
} from './contexts.js';
import { createExpressionEngine } from './engine.js';

const now = new Date('2026-01-05T09:00:00Z');

const eventRow = {
  id: 'e1',
  sourceId: 's1',
  sourceType: 'github',
  type: 'github.pr.labeled',
  occurredAt: now,
  receivedAt: now,
  artifact: { kind: 'github.pr', id: '1' },
  attributes: {},
  dedupeKey: 'k',
  deliveryId: 'd1',
  rawRef: 'r1',
  replayOf: 'e0',
} as EventRow;
const event = toEvent(eventRow);

const processRow = {
  id: 'p1',
  name: 'Autofix',
  enabled: true,
  version: 3,
  document: defaultProcessDocument('Autofix', 'x1'),
} as ProcessRow;
const process = processView(processRow);

const runRow = {
  id: 'r1',
  processId: 'p1',
  destinationId: 'x1',
  status: 'ok',
  statusReason: null,
  kind: 'event',
  dryRun: false,
  externalId: null,
  externalUrl: null,
  usage: null,
  invokedAt: now,
  finishedAt: now,
} as RunRow;
const run = runView(runRow);

const runContextKeys: Record<keyof RunContext, true> = {
  id: true,
  dryRun: true,
  mode: true,
  processId: true,
  processName: true,
  callbackUrl: true,
  deadline: true,
};
const runContext: RunContext = {
  id: 'r1',
  dryRun: false,
  mode: 'event',
  processId: 'p1',
  processName: 'Autofix',
  callbackUrl: 'https://sb.example.com/callbacks/x1',
  deadline: now.toISOString(),
};

const names = (fields: readonly ContextField[]) => fields.map((f) => f.name).sort();
const keys = (value: object) => Object.keys(value).sort();

describe('expression context descriptors', () => {
  it('describe every field the row views put in a context', () => {
    expect(names(EVENT_FIELDS)).toEqual(keys(event));
    expect(names(PROCESS_FIELDS)).toEqual(keys(process));
    expect(names(RUN_FIELDS)).toEqual(keys(run));
    expect(names(RUN_CONTEXT_FIELDS)).toEqual(Object.keys(runContextKeys).sort());
  });

  it('match what each context builder produces', () => {
    const mapping = mappingContext({ events: [event], process, run: runContext, mode: 'event' });
    const built = {
      filter: filterContext(event, process, now),
      batchKey: filterContext(event, process, now),
      approval: approvalContext(mapping, { id: 'b1', kind: 'event', size: 1 }),
      mapping,
      step: stepContext({ events: [event], run, result: {} }),
      template: templateContext({
        process,
        events: [event],
        status: 'ok',
        batch: { id: 'b1', kind: 'event' },
        reason: null,
        run,
        bindingLimit: null,
      }),
    };
    for (const [kind, context] of Object.entries(built)) {
      const described = EXPRESSION_CONTEXTS[kind as keyof typeof EXPRESSION_CONTEXTS];
      expect(names(described), kind).toEqual(keys(context));
    }
  });

  it('list exactly the functions the engine binds', async () => {
    const engine = createExpressionEngine();
    const fns = { now };
    for (const f of SWITCHBOARD_FUNCTIONS.filter((x) => x.available)) {
      const out = await engine.evaluate(`$type($${f.name})`, {}, fns);
      expect(out, f.name).toEqual({ ok: true, value: 'function' });
    }
    for (const f of SWITCHBOARD_FUNCTIONS.filter((x) => !x.available)) {
      expect((await engine.evaluate(`$${f.name}('x')`, {}, fns)).ok, f.name).toBe(false);
    }
  });

  it('import nothing at runtime, so the UI can load them', () => {
    const source = readFileSync(new URL('./context-descriptors.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^import (?!type )/m);
  });
});
