import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { approvals, auditLog, notificationLog, processes, steps } from '../../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { EXEC_TYPE, callbackRequest } from '../helpers/fake-runtime.js';
import {
  batchesOf,
  createHarness,
  deliver,
  resetDb,
  runsOf,
  seedExecutor,
  seedProcess,
  seedSource,
  setSystemNotifier,
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

async function fireOne(sourceId: string, id: string): Promise<void> {
  await deliver(h, sourceId, [{ id, version: 'v1' }]);
  await h.drain();
  await h.advance(31);
}

describe('approval', () => {
  it('holds the batch, then approve runs it with an audit row', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, { gates: { approval: 'always' } });
    await fireOne(src.id, '1');
    const [batch] = await batchesOf(h.db, pid);
    expect(batch).toMatchObject({ outcome: 'awaiting_approval', approvalState: 'pending' });
    const [pending] = await h.db.select().from(approvals).where(eq(approvals.batchId, batch!.id));
    expect(pending).toMatchObject({ rule: 'always', decision: null });
    expect(pending?.input).toMatchObject({ mode: 'event', artifacts: ['1'] });
    expect(await runsOf(h.db, pid)).toHaveLength(0);

    const out = await h.pipeline.approve(batch!.id, 'op@example.com', 'looks right');
    expect(out.outcome).toBe('ok');
    expect(await runsOf(h.db, pid)).toHaveLength(1);
    const [decided] = await h.db.select().from(approvals).where(eq(approvals.batchId, batch!.id));
    expect(decided).toMatchObject({
      decision: 'approved',
      decidedBy: 'op@example.com',
      reason: 'looks right',
    });
    const audit = await h.db.select().from(auditLog).where(eq(auditLog.scope, 'approval'));
    expect(audit).toHaveLength(1);
    await expect(h.pipeline.approve(batch!.id, 'op@example.com', 'twice')).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('an approval expression holds only matching batches; reject closes it', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      gates: { approval: "events.attributes.repository = 'acme/prod'" },
      batching: { groupBy: 'attributes.repository' },
    });
    await deliver(h, src.id, [
      { id: '1', version: 'a', repository: 'acme/prod' },
      { id: '2', version: 'a', repository: 'acme/dev' },
    ]);
    await h.drain();
    await h.advance(31);
    const batches = await batchesOf(h.db, pid);
    const prod = batches.find((b) => b.batchKey === 'acme/prod');
    const dev = batches.find((b) => b.batchKey === 'acme/dev');
    expect(prod?.outcome).toBe('awaiting_approval');
    expect(dev?.outcome).toBe('invoked');
    await h.pipeline.reject(prod!.id, 'op@example.com', 'not now');
    const [after] = (await batchesOf(h.db, pid)).filter((b) => b.id === prod!.id);
    expect(after).toMatchObject({ outcome: 'rejected', approvalState: 'rejected' });
  });

  it('a dry run skips approval, is not counted and reaches the executor with dryRun', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      gates: { approval: 'always' },
      budgets: { runsPerDay: 1 },
    });
    const out = await h.pipeline.runNow(pid, {
      dryRun: true,
      actor: 'op@example.com',
      reason: 'test run',
    });
    expect(out.outcome).toBe('ok');
    expect(ex.state.invocations[0]?.run.dryRun).toBe(true);
    expect(ex.state.invocations[0]?.run.mode).toBe('manual');
    const again = await h.pipeline.runNow(pid, {
      dryRun: true,
      actor: 'op@example.com',
      reason: 'test run',
    });
    expect(again.outcome).toBe('ok');
    // A real manual run still needs approval.
    const real = await h.pipeline.runNow(pid, { actor: 'op@example.com', reason: 'go' });
    expect(real).toMatchObject({ outcome: 'awaiting_approval', runId: null });
  });

  it('a test run replays the events of a chosen batch', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id);
    await fireOne(src.id, '42');
    const [batch] = await batchesOf(h.db, pid);
    const out = await h.pipeline.runNow(pid, {
      dryRun: true,
      batchId: batch!.id,
      actor: 'op',
      reason: 'test',
    });
    expect(out.outcome).toBe('ok');
    expect(ex.state.invocations.at(-1)?.input).toMatchObject({ mode: 'event', artifacts: ['42'] });
  });
});

describe('breaker', () => {
  it('opens after N failures, holds, alerts, and closes by hand or after cooldown', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { tracking: 'callback' });
    const notifier = h.runtime.addNotifier('system-notifier', 'System');
    await setSystemNotifier(h.db, 'system-notifier', h.clock.now());
    const pid = await seedProcess(h, ex.id, src.id, {
      gates: { breaker: { threshold: 2, cooldownMinutes: 30 } },
    });
    for (const id of ['1', '2']) {
      await fireOne(src.id, id);
      const run = (await runsOf(h.db, pid)).at(-1)!;
      await h.pipeline.handleCallback(
        ex.id,
        callbackRequest('callback-token', { runId: run.id, state: 'error' }),
      );
      await h.drain();
    }
    const [proc] = await h.db.select().from(processes).where(eq(processes.id, pid));
    expect(proc?.breakerState).toBe('open');
    expect(notifier.messages.some((m) => m.title.startsWith('Breaker opened'))).toBe(true);

    await fireOne(src.id, '3');
    expect((await batchesOf(h.db, pid)).at(-1)).toMatchObject({
      outcome: 'held',
      outcomeReason: 'breaker_open',
    });

    await h.pipeline.resetBreaker(pid, 'op@example.com', 'fixed the routine');
    await fireOne(src.id, '4');
    expect((await batchesOf(h.db, pid)).at(-1)?.outcome).toBe('invoked');
    // Old failures do not count after a reset: one more error does not re-open.
    const run = (await runsOf(h.db, pid)).at(-1)!;
    await h.pipeline.handleCallback(
      ex.id,
      callbackRequest('callback-token', { runId: run.id, state: 'error' }),
    );
    const [still] = await h.db.select().from(processes).where(eq(processes.id, pid));
    expect(still?.breakerState).toBe('closed');

    // A second failure re-opens; the cooldown closes it.
    await fireOne(src.id, '5');
    const run5 = (await runsOf(h.db, pid)).at(-1)!;
    await h.pipeline.handleCallback(
      ex.id,
      callbackRequest('callback-token', { runId: run5.id, state: 'unknown' }),
    );
    const [reopened] = await h.db.select().from(processes).where(eq(processes.id, pid));
    expect(reopened?.breakerState).toBe('open');
    h.clock.advanceMinutes(31);
    await fireOne(src.id, '6');
    expect((await batchesOf(h.db, pid)).at(-1)?.outcome).toBe('invoked');
  });
});

describe('other gates', () => {
  it('quiet hours, a disabled executor and an unavailable plugin hold with their reasons', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const quiet = await seedProcess(h, ex.id, src.id, {
      gates: { quietHours: { start: '08:00', end: '10:00' } },
    });
    await fireOne(src.id, '1');
    expect((await batchesOf(h.db, quiet))[0]).toMatchObject({
      outcome: 'held',
      outcomeReason: 'quiet_hours',
    });

    const ex2 = await seedExecutor(h, { enabled: false });
    const disabled = await seedProcess(h, ex2.id, src.id);
    const ex3 = await seedExecutor(h);
    const unavailable = await seedProcess(h, ex3.id, src.id);
    h.runtime.unavailableTypes.add(EXEC_TYPE);
    await fireOne(src.id, '2');
    expect((await batchesOf(h.db, disabled))[0]?.outcomeReason).toBe('executor_disabled');
    expect((await batchesOf(h.db, unavailable))[0]?.outcomeReason).toBe('plugin_unavailable');
  });

  it('a disabled process holds a manual run', async () => {
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, null, {}, false);
    const out = await h.pipeline.runNow(pid, { actor: 'op', reason: 'try' });
    expect(out.outcome).toBe('held');
    expect((await batchesOf(h.db, pid))[0]?.outcomeReason).toBe('process_disabled');
  });
});

describe('steps and notifications', () => {
  it('runs before/after steps with conditions and sends notifications on the terminal state', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const notifier = h.runtime.addNotifier('n1', 'Slack');
    h.secrets.set('secret://env/TOKEN', 'the-token-value');
    const pid = await seedProcess(h, ex.id, src.id, {
      input: '{ "runId": run.id, "mode": mode, "token": $secretRef("env/TOKEN") }',
      before: [
        {
          provider: src.id,
          action: 'addLabel',
          args: '{ "label": "working", "id": events[0].artifact.id }',
        },
      ],
      after: [
        {
          provider: src.id,
          action: 'comment',
          args: '{ "text": "done " & result.status }',
          when: "result.status = 'ok'",
        },
        {
          provider: src.id,
          action: 'addLabel',
          args: '{ "label": "failed" }',
          when: "result.status = 'error'",
        },
      ],
      notify: [
        {
          notifierId: 'n1',
          template: "'Run ' & run.status & ' for ' & process.name",
          on: ['ok', 'error'],
        },
      ],
    });
    await fireOne(src.id, '1');
    const [run] = await runsOf(h.db, pid);
    expect(run?.status).toBe('ok');
    // The secret value reached the executor but was never stored.
    expect(ex.state.invocations[0]?.input).toMatchObject({ token: 'the-token-value' });
    expect(run?.input).toMatchObject({ token: { $secretRef: 'secret://env/TOKEN' } });
    expect(src.state.actions).toEqual([
      { action: 'addLabel', args: { label: 'working', id: '1' } },
      { action: 'comment', args: { text: 'done ok' } },
    ]);
    const rows = await h.db.select().from(steps).where(eq(steps.runId, run!.id));
    expect(rows.map((s) => [s.phase, s.status]).sort()).toEqual([
      ['after', 'ok'],
      ['after', 'skipped'],
      ['before', 'ok'],
    ]);
    expect(notifier.messages.map((m) => m.text)).toEqual(['Run ok for Autofix']);
    expect(await h.db.select().from(notificationLog)).toHaveLength(1);
  });

  it('a failing before step fails the run before invoke', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    src.state.actionResult = { ok: false, message: 'label not found' };
    const pid = await seedProcess(h, ex.id, src.id, {
      before: [{ provider: src.id, action: 'addLabel', args: '{ "label": "x" }' }],
    });
    await fireOne(src.id, '1');
    expect(await runsOf(h.db, pid)).toMatchObject([
      { status: 'failed', statusReason: 'before_step_failed' },
    ]);
    expect(ex.state.invocations).toHaveLength(0);
  });

  it('notifies on held and throttled batches', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const notifier = h.runtime.addNotifier('n1', 'Slack');
    await seedProcess(h, ex.id, src.id, {
      budgets: { runsPerHour: 0 },
      notify: [{ notifierId: 'n1', template: "'throttled: ' & reason", on: ['throttled'] }],
    });
    await seedProcess(h, ex.id, src.id, {
      gates: { quietHours: { start: '00:00', end: '23:59' } },
      notify: [{ notifierId: 'n1', template: "'held: ' & reason", on: ['held'] }],
    });
    await fireOne(src.id, '1');
    const texts = notifier.messages.map((m) => m.text).sort();
    expect(texts[0]).toMatch(/^held: quiet_hours/);
    expect(texts[1]).toMatch(/^throttled: /);
  });
});
