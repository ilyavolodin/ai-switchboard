import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evaluationAdminEmail, LOCAL_ADMIN_EMAIL } from '../../src/auth/bootstrap.js';
import { hashPassword, verifyPassword } from '../../src/auth/crypto.js';
import { createSession } from '../../src/auth/sessions.js';
import { emailKey } from '../../src/auth/throttle.js';
import { FakeClock } from '../../src/clock.js';
import { testConfig } from '../../src/config.js';
import { auditLog, loginAttempts, sessions, users } from '../../src/db/schema.js';
import { accountRecovery } from '../../src/account-recovery.js';
import {
  createAdmin,
  isRecoveryError,
  listAccounts,
  resetPassword,
  type RecoveryError,
} from '../../src/services/recovery.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let tdb: TestDatabase;
const clock = new FakeClock(new Date('2026-09-28T09:00:00Z'));
const audit = { actor: 'cli@box-1', reason: 'locked out', at: clock.now() };

async function addUser(
  email: string,
  role: 'admin' | 'operator' | 'viewer',
  password?: string,
): Promise<string> {
  const [row] = await tdb.db
    .insert(users)
    .values({
      email,
      role,
      passwordHash: password === undefined ? null : await hashPassword(password),
      createdAt: clock.now(),
    })
    .returning();
  if (!row) throw new Error('insert failed');
  return row.id;
}

async function refusal(p: Promise<unknown>): Promise<RecoveryError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isRecoveryError(err)) throw new Error(`expected a RecoveryError, got ${String(err)}`);
  return err;
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  await addUser(LOCAL_ADMIN_EMAIL, 'admin', 'the-original-admin-pw-1');
  await addUser('carol@acme.test', 'operator', 'carols-own-password-2');
  await addUser('dave@acme.test', 'viewer');
});

afterAll(async () => {
  await tdb.destroy();
});

describe('account recovery', () => {
  it('lists every account without password material', async () => {
    const list = await listAccounts(tdb.db);
    expect(list.map((a) => [a.email, a.role, a.hasPassword])).toEqual([
      [LOCAL_ADMIN_EMAIL, 'admin', true],
      ['carol@acme.test', 'operator', true],
      ['dave@acme.test', 'viewer', false],
    ]);
    expect(JSON.stringify(list)).not.toContain('scrypt');
  });

  it('resets to a temporary password, revokes sessions, clears failures and audits', async () => {
    const [carol] = await tdb.db.select().from(users).where(eq(users.email, 'carol@acme.test'));
    if (!carol) throw new Error('missing carol');
    await createSession(tdb.db, carol.id, 'password', clock.now());
    await createSession(tdb.db, carol.id, 'oidc', clock.now());
    await tdb.db
      .insert(loginAttempts)
      .values([1, 2, 3, 4, 5].map(() => ({ key: emailKey('carol@acme.test'), at: clock.now() })));

    const result = await resetPassword(tdb.db, { email: ' Carol@ACME.test ', audit });
    expect(result).toMatchObject({ email: 'carol@acme.test', role: 'operator', generated: true });

    const [after] = await tdb.db.select().from(users).where(eq(users.id, carol.id));
    expect(after?.mustChangePassword).toBe(true);
    expect(await verifyPassword(result.password, after?.passwordHash ?? '')).toBe(true);
    expect(await verifyPassword('carols-own-password-2', after?.passwordHash ?? '')).toBe(false);
    expect(await tdb.db.select().from(sessions).where(eq(sessions.userId, carol.id))).toEqual([]);
    expect(
      await tdb.db
        .select()
        .from(loginAttempts)
        .where(eq(loginAttempts.key, emailKey('carol@acme.test'))),
    ).toEqual([]);

    const rows = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, carol.id), eq(auditLog.field, 'password_reset')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'cli@box-1', reason: 'locked out', after: 'temporary' });
    expect(JSON.stringify(rows)).not.toContain(result.password);
  });

  it('applies the password rules to a given password', async () => {
    const err = await refusal(
      resetPassword(tdb.db, { email: 'carol@acme.test', password: 'short', audit }),
    );
    expect(err.code).toBe('invalid_password');
    const ok = await resetPassword(tdb.db, {
      email: 'carol@acme.test',
      password: 'a-chosen-temporary-9',
      audit,
    });
    expect(ok.generated).toBe(false);
  });

  it('refuses an unknown email with close matches and changes nothing', async () => {
    const before = await tdb.db.select().from(auditLog);
    const err = await refusal(resetPassword(tdb.db, { email: 'admin@switchboard.lokal', audit }));
    expect(err.code).toBe('unknown_user');
    expect(err.suggestions).toEqual([LOCAL_ADMIN_EMAIL]);
    expect(await tdb.db.select().from(auditLog)).toHaveLength(before.length);
  });

  it('refuses an empty reason', async () => {
    const err = await refusal(
      resetPassword(tdb.db, { email: 'carol@acme.test', audit: { ...audit, reason: ' ' } }),
    );
    expect(err.code).toBe('no_reason');
  });

  it('creates a break-glass admin, or promotes an existing account', async () => {
    const created = await createAdmin(tdb.db, { email: 'ops@acme.test', audit });
    expect(created).toMatchObject({ change: 'created', role: 'admin', generated: true });
    const promoted = await createAdmin(tdb.db, { email: 'dave@acme.test', audit });
    expect(promoted.change).toBe('promoted');
    const again = await createAdmin(tdb.db, { email: 'dave@acme.test', audit });
    expect(again.change).toBe('unchanged');

    const [dave] = await tdb.db.select().from(users).where(eq(users.email, 'dave@acme.test'));
    expect(dave).toMatchObject({ role: 'admin', mustChangePassword: true });
    expect(await verifyPassword(again.password, dave?.passwordHash ?? '')).toBe(true);
    const roleRows = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, dave?.id ?? ''), eq(auditLog.field, 'role')));
    expect(roleRows).toEqual([
      expect.objectContaining({ before: 'viewer', after: 'admin', actor: 'cli@box-1' }),
    ]);
    const err = await refusal(createAdmin(tdb.db, { email: 'not-an-email', audit }));
    expect(err.code).toBe('invalid_email');
  });

  it('works from a config through accountRecovery', async () => {
    const recovery = accountRecovery(clock);
    const config = testConfig({ databaseUrl: tdb.url });
    const list = await recovery.listUsers(config);
    expect(list.map((a) => a.email)).toContain('ops@acme.test');
    const r = await recovery.resetPassword(config, {
      email: 'ops@acme.test',
      actor: 'cli@box-1',
      reason: 'via config',
    });
    expect(r.email).toBe('ops@acme.test');
  });
});

describe('evaluationAdminEmail', () => {
  it('names the bootstrap local admin in evaluation mode only', async () => {
    expect(
      await evaluationAdminEmail(tdb.db, { evaluation: true, bootstrapAdmin: undefined }),
    ).toBe(LOCAL_ADMIN_EMAIL);
    expect(
      await evaluationAdminEmail(tdb.db, { evaluation: false, bootstrapAdmin: undefined }),
    ).toBeNull();
    expect(
      await evaluationAdminEmail(tdb.db, { evaluation: true, bootstrapAdmin: 'Dave@acme.test' }),
    ).toBe('dave@acme.test');
    // A named bootstrap admin without a password (OIDC) is not a local admin to hint at.
    await addUser('erin@acme.test', 'admin');
    expect(
      await evaluationAdminEmail(tdb.db, { evaluation: true, bootstrapAdmin: 'erin@acme.test' }),
    ).toBeNull();
    expect(
      await evaluationAdminEmail(tdb.db, { evaluation: true, bootstrapAdmin: 'nobody@acme.test' }),
    ).toBeNull();
  });
});
