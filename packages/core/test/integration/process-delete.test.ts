import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { approvals, auditLog, events, processes } from '../../src/db/schema.js';
import { deleteProcess } from '../../src/services/processes.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import {
  batchesOf,
  createHarness,
  deliver,
  resetDb,
  runsOf,
  seedDestination,
  seedProcess,
  seedSource,
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

const meta = () => ({ actor: 'op@example.com', reason: 'retired', now: h.clock.now() });

describe('deleting a process', () => {
  it('drops its unfinished batches, withdraws pending approvals and keeps the history', async () => {
    const src = await seedSource(h);
    const ex = await seedDestination(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      gates: { approval: "events.attributes.repository = 'acme/prod'" },
      batching: { groupBy: 'attributes.repository' },
    });
    // One run that finished, one batch awaiting approval, one batch still open.
    await deliver(h, src.id, [
      { id: '1', version: 'a', repository: 'acme/dev' },
      { id: '2', version: 'a', repository: 'acme/prod' },
    ]);
    await h.drain();
    await h.advance(31);
    await deliver(h, src.id, [{ id: '3', version: 'a', repository: 'acme/dev' }]);
    await h.drain();
    const before = await batchesOf(h.db, pid);
    expect(before.map((b) => b.outcome).sort()).toEqual(['awaiting_approval', 'invoked', 'open']);
    expect(await runsOf(h.db, pid)).toHaveLength(1);

    const out = await deleteProcess(h.db, pid, meta());
    expect(out).toEqual({ droppedBatches: 2, withdrawnApprovals: 1 });

    const after = await batchesOf(h.db, pid);
    const invoked = after.filter((b) => b.outcome === 'invoked');
    const dropped = after.filter((b) => b.outcome === 'rejected');
    expect(invoked).toHaveLength(1);
    expect(dropped).toHaveLength(2);
    for (const b of dropped) {
      expect(b).toMatchObject({ outcomeReason: 'process_deleted' });
      expect(b.closedAt).not.toBeNull();
      expect(b.decisions.at(-1)).toMatchObject({
        stage: 'batch',
        check: 'process_deleted',
        pass: false,
        detail: 'op@example.com: retired',
      });
    }
    expect(dropped.find((b) => b.batchKey === 'acme/prod')?.approvalState).toBe('rejected');

    const [approval] = await h.db.select().from(approvals).where(eq(approvals.processId, pid));
    expect(approval).toMatchObject({
      decision: 'withdrawn',
      decidedBy: 'op@example.com',
      reason: 'retired',
    });
    const audit = await h.db.select().from(auditLog);
    expect(audit.find((r) => r.scope === 'approval')).toMatchObject({
      targetId: approval?.batchId,
      before: 'pending',
      after: 'withdrawn',
    });
    expect(audit.find((r) => r.scope === 'process' && r.field === 'deleted')).toMatchObject({
      targetId: pid,
      reason: 'retired',
    });

    // Runs and events stay for the trace; nothing fires later.
    expect(await runsOf(h.db, pid)).toHaveLength(1);
    expect(await h.db.select().from(events).where(eq(events.sourceId, src.id))).toHaveLength(3);
    await h.advance(700);
    expect(await runsOf(h.db, pid)).toHaveLength(1);
    expect(ex.state.invocations).toHaveLength(1);
    expect(
      (await batchesOf(h.db, pid)).filter(
        (b) => b.outcome === 'open' || b.outcome === 'closed' || b.outcome === 'held',
      ),
    ).toEqual([]);
    expect(await h.db.select().from(processes).where(eq(processes.id, pid))).toEqual([]);
  });

  it('leaves other processes alone and returns null for an unknown process', async () => {
    const src = await seedSource(h);
    const ex = await seedDestination(h);
    const gone = await seedProcess(h, ex.id, src.id);
    const kept = await seedProcess(h, ex.id, src.id, { name: 'Kept' });
    await deliver(h, src.id, [{ id: '1', version: 'a' }]);
    await h.drain();
    expect(await deleteProcess(h.db, gone, meta())).toEqual({
      droppedBatches: 1,
      withdrawnApprovals: 0,
    });
    const [open] = await batchesOf(h.db, kept);
    expect(open?.outcome).toBe('open');
    await h.advance(31);
    expect(await runsOf(h.db, kept)).toHaveLength(1);
    expect(await deleteProcess(h.db, gone, meta())).toBeNull();
    const audits = await h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.scope, 'process'), eq(auditLog.field, 'deleted')));
    expect(audits).toHaveLength(1);
  });
});

describe('batching off', () => {
  it('debounce 0, max size 1, max age 0: every event is its own run at once', async () => {
    const src = await seedSource(h);
    const ex = await seedDestination(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      batching: { debounceSeconds: 0, maxSize: 1, maxAgeSeconds: 0 },
    });
    await deliver(h, src.id, [
      { id: '1', version: 'a' },
      { id: '2', version: 'a' },
      { id: '3', version: 'a' },
    ]);
    // No clock advance: nothing waits.
    await h.drain();
    const bs = await batchesOf(h.db, pid);
    expect(bs).toHaveLength(3);
    expect(bs.every((b) => b.size === 1 && b.outcome === 'invoked')).toBe(true);
    expect(await runsOf(h.db, pid)).toHaveLength(3);
  });
});
