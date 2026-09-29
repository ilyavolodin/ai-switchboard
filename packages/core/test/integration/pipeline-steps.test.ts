import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { batches, notificationLog, runs, steps } from '../../src/db/schema.js';
import type { StepPhase, StepStatus } from '../../src/domain/status.js';
import { JOBS } from '../../src/services/pipeline/context.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { callbackRequest } from '../helpers/fake-runtime.js';
import {
  createHarness,
  deliver,
  resetDb,
  runsOf,
  seedDestination,
  seedProcess,
  seedSource,
  type DocPatch,
  type Harness,
} from '../helpers/harness.js';

let tdb: TestDatabase;
let h: Harness;

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});
beforeEach(async () => {
  await resetDb(tdb.db);
  h = await createHarness(tdb.db);
});

type Seeded = Awaited<ReturnType<typeof seedWith>>;

/** A run reserved by a replica that then died. `inFlight`: its attempt is past its deadline. */
async function reservedRun(s: Seeded, opts: { inFlight?: boolean } = {}): Promise<string> {
  const batchId = randomUUID();
  const now = h.clock.now();
  await h.db.insert(batches).values({
    id: batchId,
    processId: s.pid,
    kind: 'manual',
    openedAt: now,
    fireAfter: now,
    closedAt: now,
    outcome: 'invoked',
  });
  const past = new Date(now.getTime() - 3_600_000);
  const [run] = await h.db
    .insert(runs)
    .values({
      batchId,
      processId: s.pid,
      processVersion: 1,
      destinationId: s.ex.id,
      kind: 'manual',
      status: 'invoking',
      input: { runId: 'x', mode: 'sweep', artifacts: [] },
      invokedAt: past,
      deadlineAt: new Date(now.getTime() + 3_600_000),
      createdAt: past,
      ...(opts.inFlight
        ? { attempts: 1, invokeStartedAt: past, invokeDeadlineAt: new Date(now.getTime() - 1000) }
        : {}),
    })
    .returning({ id: runs.id });
  return run!.id;
}

async function journal(
  runId: string,
  phase: StepPhase,
  index: number,
  action: string,
  status: StepStatus,
  providerId: string,
) {
  await h.db.insert(steps).values({
    runId,
    phase,
    index,
    providerId,
    action,
    args: null,
    status,
    error: null,
    at: h.clock.now(),
  });
}

async function stepRows(runId: string) {
  const rows = await h.db.select().from(steps).where(eq(steps.runId, runId));
  return rows
    .sort((a, b) => a.phase.localeCompare(b.phase) || a.index - b.index)
    .map((r) => [r.phase, r.index, r.action, r.status]);
}

async function recover(): Promise<void> {
  await h.pipeline.maintenance();
  await h.drain();
}

const labelThenComment: DocPatch = {
  before: [
    { provider: '$SRC', action: 'addLabel', args: '{ "label": "working" }' },
    { provider: '$SRC', action: 'comment', args: '{ "text": "started" }' },
  ],
};

/** `provider: '$SRC'` → the seeded source id. */
function withSource(patch: DocPatch, sourceId: string): DocPatch {
  const fix = (list: DocPatch['before']) =>
    list?.map((st) => ({ ...st, provider: st.provider === '$SRC' ? sourceId : st.provider }));
  return {
    ...patch,
    ...(patch.before ? { before: fix(patch.before) } : {}),
    ...(patch.after ? { after: fix(patch.after) } : {}),
  };
}

async function seedWith(patch: DocPatch, destination: { idempotent?: boolean } = {}) {
  const src = await seedSource(h);
  const ex = await seedDestination(h, { tracking: 'callback', ...destination });
  const pid = await seedProcess(h, ex.id, src.id, withSource(patch, src.id));
  return { src, ex, pid };
}

describe('before steps resume from the journal', () => {
  it('a crash between two before steps resumes with the second, then invokes', async () => {
    const s = await seedWith(labelThenComment);
    const runId = await reservedRun(s);
    await journal(runId, 'before', 0, 'addLabel', 'ok', s.src.id);
    await recover();
    expect(s.src.state.actions).toEqual([{ action: 'comment', args: { text: 'started' } }]);
    expect(s.ex.state.invocations).toHaveLength(1);
    expect(await stepRows(runId)).toEqual([
      ['before', 0, 'addLabel', 'ok'],
      ['before', 1, 'comment', 'ok'],
    ]);
    expect((await runsOf(h.db, s.pid))[0]?.status).toBe('running');
  });

  it('an idempotent step left in doubt runs again', async () => {
    const s = await seedWith(labelThenComment);
    const runId = await reservedRun(s);
    await journal(runId, 'before', 0, 'addLabel', 'started', s.src.id);
    await recover();
    expect(s.src.state.actions.map((a) => a.action)).toEqual(['addLabel', 'comment']);
    expect(s.ex.state.invocations).toHaveLength(1);
    expect(await stepRows(runId)).toEqual([
      ['before', 0, 'addLabel', 'ok'],
      ['before', 1, 'comment', 'ok'],
    ]);
  });

  it('a non-idempotent step left in doubt fails the run before invoke', async () => {
    const s = await seedWith(labelThenComment);
    const runId = await reservedRun(s);
    await journal(runId, 'before', 0, 'addLabel', 'ok', s.src.id);
    await journal(runId, 'before', 1, 'comment', 'started', s.src.id);
    await recover();
    expect(s.src.state.actions).toEqual([]);
    expect(s.ex.state.invocations).toHaveLength(0);
    const [run] = await runsOf(h.db, s.pid);
    // Nothing was sent: the reservation is released (attempts 0) and there is no after phase.
    expect(run).toMatchObject({
      status: 'failed',
      statusReason: 'step_in_doubt:before[1] comment',
      attempts: 0,
    });
    expect(await stepRows(runId)).toEqual([
      ['before', 0, 'addLabel', 'ok'],
      ['before', 1, 'comment', 'started'],
    ]);
  });

  it('an attempt that stopped in its steps is resumed, not made uncertain', async () => {
    // Non-idempotent destination: an attempt past its deadline is normally `uncertain`. This one
    // never got past its first step, so invoke was certainly not called.
    const s = await seedWith(labelThenComment, { idempotent: false });
    const runId = await reservedRun(s, { inFlight: true });
    await journal(runId, 'before', 0, 'addLabel', 'started', s.src.id);
    await recover();
    expect(s.src.state.actions.map((a) => a.action)).toEqual(['addLabel', 'comment']);
    expect(s.ex.state.invocations).toHaveLength(1);
    expect((await runsOf(h.db, s.pid))[0]?.status).toBe('running');
  });

  it('an attempt past its deadline after all its steps settled is uncertain', async () => {
    const s = await seedWith(labelThenComment, { idempotent: false });
    const runId = await reservedRun(s, { inFlight: true });
    await journal(runId, 'before', 0, 'addLabel', 'ok', s.src.id);
    await journal(runId, 'before', 1, 'comment', 'ok', s.src.id);
    await recover();
    expect(s.ex.state.invocations).toHaveLength(0);
    expect((await runsOf(h.db, s.pid))[0]?.status).toBe('uncertain');
  });
});

describe('after steps and notifications', () => {
  const afterPatch: DocPatch = {
    after: [
      { provider: '$SRC', action: 'comment', args: '{ "text": "done" }' },
      { provider: '$SRC', action: 'addLabel', args: '{ "label": "done" }' },
    ],
    notify: [{ notifierId: 'n1', template: "'Run ' & run.status", on: ['ok'] }],
  };

  async function finishedRun(s: Seeded): Promise<string> {
    await deliver(h, s.src.id, [{ id: '1', version: 'v1' }]);
    await h.drain();
    await h.advance(31);
    const [run] = await runsOf(h.db, s.pid);
    return run!.id;
  }

  it('an after step left in doubt is recorded uncertain; the rest still run', async () => {
    const s = await seedWith(afterPatch);
    const notifier = h.runtime.addNotifier('n1', 'Slack');
    const runId = await finishedRun(s);
    // The run is open (callback tracking): journal a comment that a crashed finish left behind.
    await journal(runId, 'after', 0, 'comment', 'started', s.src.id);
    await h.pipeline.handleCallback(
      s.ex.id,
      callbackRequest('callback-token', { runId, state: 'ok' }),
    );
    await h.drain();
    expect(s.src.state.actions).toEqual([{ action: 'addLabel', args: { label: 'done' } }]);
    expect(await stepRows(runId)).toEqual([
      ['after', 0, 'comment', 'uncertain'],
      ['after', 1, 'addLabel', 'ok'],
    ]);
    expect(notifier.messages).toHaveLength(1);
  });

  it('a redelivered finish job neither repeats after steps nor notifies twice', async () => {
    const s = await seedWith(afterPatch);
    const notifier = h.runtime.addNotifier('n1', 'Slack');
    const runId = await finishedRun(s);
    await h.pipeline.handleCallback(
      s.ex.id,
      callbackRequest('callback-token', { runId, state: 'ok' }),
    );
    await h.drain();
    expect(notifier.messages).toHaveLength(1);
    // Two replicas pick up redeliveries of the same finish job at once.
    const other = await h.replica();
    await h.queue.send(JOBS.finish, { runId });
    await other.queue.send(JOBS.finish, { runId });
    await Promise.all([h.drain(), other.queue.drain()]);
    expect(notifier.messages).toHaveLength(1);
    expect(s.src.state.actions.map((a) => a.action)).toEqual(['comment', 'addLabel']);
    const logged = await h.db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.runId, runId), eq(notificationLog.notifierId, 'n1')));
    expect(logged).toMatchObject([{ status: 'sent', text: 'Run ok' }]);
  });

  it('a notification claimed by a crashed attempt is not sent again', async () => {
    const s = await seedWith({ notify: afterPatch.notify ?? [] });
    const notifier = h.runtime.addNotifier('n1', 'Slack');
    const runId = await finishedRun(s);
    await h.db.insert(notificationLog).values({
      notifierId: 'n1',
      on: 'ok',
      processId: s.pid,
      runId,
      title: 'Autofix: ok',
      text: '',
      status: 'sending',
      at: h.clock.now(),
    });
    await h.pipeline.handleCallback(
      s.ex.id,
      callbackRequest('callback-token', { runId, state: 'ok' }),
    );
    await h.drain();
    expect(notifier.messages).toHaveLength(0);
  });
});
