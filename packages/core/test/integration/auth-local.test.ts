import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MeResponse, UserDTO } from '../../src/api/contract.js';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { verifyPassword } from '../../src/auth/crypto.js';
import { OidcClient } from '../../src/auth/oidc.js';
import { testConfig } from '../../src/config.js';
import { auditLog, users } from '../../src/db/schema.js';
import { silentLogger } from '../../src/logger.js';
import { ADMIN_EMAIL, createApiHarness, type ApiHarness } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let tdb: TestDatabase;
let h: ApiHarness;

beforeAll(async () => {
  tdb = await createTestDatabase();
  h = await createApiHarness(tdb);
});

afterAll(async () => {
  await h.close();
  await tdb.destroy();
});

const reason = 'integration test';
const TEMP = 'temporary-river-lamp-1';
const CHOSEN = 'my-own-quiet-harbour-9';

async function createUser(email: string, password?: string): Promise<UserDTO> {
  const res = await h.request('POST', '/api/v1/users', {
    cookie: h.adminCookie,
    body: { email, role: 'operator', reason, ...(password !== undefined ? { password } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<UserDTO>();
}

async function me(cookie: string): Promise<MeResponse> {
  return (await h.request('GET', '/api/v1/auth/me', { cookie })).json<MeResponse>();
}

async function auditValues(): Promise<string> {
  return JSON.stringify(await tdb.db.select().from(auditLog));
}

describe('local accounts', () => {
  it('creates a user with a temporary password and restricts the first session until it changes', async () => {
    const user = await createUser('carol@acme.test', TEMP);
    expect(user).toMatchObject({ hasPassword: true, mustChangePassword: true, hasOidc: false });

    const cookie = await h.login('carol@acme.test', TEMP);
    const restricted = await me(cookie);
    expect(restricted.mustChangePassword).toBe(true);
    expect(restricted.user?.email).toBe('carol@acme.test');

    const blocked = await h.request('GET', '/api/v1/processes', { cookie });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: string }>().error).toBe('password_change_required');
    const whoami = await h.request('GET', '/api/v1/auth/whoami', { cookie });
    expect(whoami.statusCode).toBe(403);

    const changed = await h.request('POST', '/api/v1/auth/password', {
      cookie,
      body: { currentPassword: TEMP, newPassword: CHOSEN },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<MeResponse>()).toMatchObject({
      mustChangePassword: false,
      user: { mustChangePassword: false, hasPassword: true },
    });

    const open = await h.request('GET', '/api/v1/processes', { cookie });
    expect(open.statusCode).toBe(200);
    // The old password no longer works; the new one does and is not restricted.
    const old = await h.request('POST', '/api/v1/auth/login', {
      body: { email: 'carol@acme.test', password: TEMP },
    });
    expect(old.statusCode).toBe(401);
    const fresh = await h.login('carol@acme.test', CHOSEN);
    expect((await me(fresh)).mustChangePassword).toBe(false);
  });

  it('rejects a wrong current password and policy violations', async () => {
    await createUser('dave@acme.test', TEMP);
    const cookie = await h.login('dave@acme.test', TEMP);
    const change = (currentPassword: string, newPassword: string) =>
      h.request('POST', '/api/v1/auth/password', {
        cookie,
        body: { currentPassword, newPassword },
      });

    const wrong = await change('not-the-password-1', CHOSEN);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: string }>().error).toBe('invalid_credentials');

    for (const [candidate, message] of [
      ['short', /at least 8/],
      ['dave@acme.test', /email/],
      ['password1', /too common/],
      [TEMP, /different/],
    ] as const) {
      const res = await change(TEMP, candidate);
      expect(res.statusCode, candidate).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(message);
    }
    expect((await me(cookie)).mustChangePassword).toBe(true);

    const weak = await h.request('POST', '/api/v1/users', {
      cookie: h.adminCookie,
      body: { email: 'erin@acme.test', role: 'viewer', password: 'short', reason },
    });
    expect(weak.statusCode).toBe(400);
    const [erin] = await tdb.db.select().from(users).where(eq(users.email, 'erin@acme.test'));
    expect(erin).toBeUndefined();
  });

  it('lets an admin set and reset a password, which re-forces a change and revokes sessions', async () => {
    const user = await createUser('frank@acme.test');
    expect(user).toMatchObject({ hasPassword: false, mustChangePassword: false });

    const noReason = await h.request('PUT', `/api/v1/users/${user.id}/password`, {
      cookie: h.adminCookie,
      body: { password: TEMP, reason: ' ' },
    });
    expect(noReason.statusCode).toBe(400);

    const set = await h.request('PUT', `/api/v1/users/${user.id}/password`, {
      cookie: h.adminCookie,
      body: { password: TEMP, reason: 'first password' },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<UserDTO>()).toMatchObject({ hasPassword: true, mustChangePassword: true });

    const first = await h.login('frank@acme.test', TEMP);
    await h.request('POST', '/api/v1/auth/password', {
      cookie: first,
      body: { currentPassword: TEMP, newPassword: CHOSEN },
    });
    const second = await h.login('frank@acme.test', CHOSEN);
    expect((await h.request('GET', '/api/v1/processes', { cookie: second })).statusCode).toBe(200);

    const RESET = 'reset-by-admin-harbour-3';
    const reset = await h.request('PUT', `/api/v1/users/${user.id}/password`, {
      cookie: h.adminCookie,
      body: { password: RESET, reason: 'forgot it' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<UserDTO>().mustChangePassword).toBe(true);
    // Every existing session is signed out.
    expect((await me(first)).user).toBeNull();
    expect((await me(second)).user).toBeNull();
    const again = await h.login('frank@acme.test', RESET);
    expect((await me(again)).mustChangePassword).toBe(true);

    const self = await h.request('GET', '/api/v1/auth/me', { cookie: h.adminCookie });
    const adminId = self.json<MeResponse>().user?.id ?? '';
    const ownReset = await h.request('PUT', `/api/v1/users/${adminId}/password`, {
      cookie: h.adminCookie,
      body: { password: RESET, reason },
    });
    expect(ownReset.statusCode).toBe(409);
  });

  it('revokes the other sessions when a user changes their own password', async () => {
    await createUser('gina@acme.test', TEMP);
    const a = await h.login('gina@acme.test', TEMP);
    const b = await h.login('gina@acme.test', TEMP);
    const res = await h.request('POST', '/api/v1/auth/password', {
      cookie: a,
      body: { currentPassword: TEMP, newPassword: CHOSEN },
    });
    expect(res.statusCode).toBe(200);
    expect((await me(a)).user?.email).toBe('gina@acme.test');
    expect((await me(b)).user).toBeNull();
  });

  it('audits password changes without the password', async () => {
    const rows = await tdb.db.select().from(auditLog).where(eq(auditLog.scope, 'user'));
    const fields = rows.map((r) => r.field);
    expect(fields).toContain('password');
    expect(fields).toContain('password_reset');
    const text = await auditValues();
    for (const secret of [TEMP, CHOSEN, 'reset-by-admin-harbour-3']) {
      expect(text).not.toContain(secret);
    }
    const [frank] = await tdb.db.select().from(users).where(eq(users.email, 'frank@acme.test'));
    expect(frank?.passwordHash).toMatch(/^scrypt\$/);
  });

  it('refuses to remove the only sign-in method without OIDC', async () => {
    const [carol] = await tdb.db.select().from(users).where(eq(users.email, 'carol@acme.test'));
    const res = await h.request('DELETE', `/api/v1/users/${carol?.id ?? ''}/password`, {
      cookie: h.adminCookie,
      body: { reason },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('local accounts alongside OIDC', () => {
  beforeAll(() => {
    h.ctx.oidc = new OidcClient(
      {
        issuer: 'https://login.acme.test/realms/main',
        clientId: 'switchboard',
        clientSecret: 'fixture-client-secret',
        allowedDomains: [],
      },
      'http://switchboard.test/api/v1/auth/oidc/callback',
      'cookie-key',
    );
  });
  afterAll(() => {
    h.ctx.oidc = undefined;
  });

  it('still signs in with a password and reports the issuer', async () => {
    const cookie = await h.login('carol@acme.test', CHOSEN);
    const res = await me(cookie);
    expect(res).toMatchObject({
      authMode: 'oidc',
      oidcConfigured: true,
      oidcIssuer: 'login.acme.test',
      user: { email: 'carol@acme.test' },
    });
  });

  it('lets an admin remove a password, making the account OIDC-only', async () => {
    const [carol] = await tdb.db.select().from(users).where(eq(users.email, 'carol@acme.test'));
    const cookie = await h.login('carol@acme.test', CHOSEN);
    const res = await h.request('DELETE', `/api/v1/users/${carol?.id ?? ''}/password`, {
      cookie: h.adminCookie,
      body: { reason: 'OIDC only' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<UserDTO>()).toMatchObject({ hasPassword: false, mustChangePassword: false });
    expect((await me(cookie)).user).toBeNull();
    const login = await h.request('POST', '/api/v1/auth/login', {
      body: { email: 'carol@acme.test', password: CHOSEN },
    });
    expect(login.statusCode).toBe(401);
    const change = await h.request('POST', '/api/v1/auth/password', {
      cookie: h.adminCookie,
      body: { currentPassword: 'x', newPassword: CHOSEN },
    });
    // The admin still has a password, so this is only a wrong confirmation, not a missing one.
    expect(change.statusCode).toBe(400);
  });
});

describe('bootstrap', () => {
  let bdb: TestDatabase;
  beforeAll(async () => {
    bdb = await createTestDatabase();
  });
  afterAll(async () => {
    await bdb.destroy();
  });
  const now = new Date('2026-03-02T10:00:00Z');

  it('makes a generated password temporary and an explicit one final', async () => {
    const generated = await bootstrapAdmin(bdb.db, testConfig(), silentLogger(), now);
    expect(generated.created).toBe(true);
    const [row] = await bdb.db.select().from(users).where(eq(users.email, ADMIN_EMAIL));
    expect(row?.mustChangePassword).toBe(true);
    expect(await verifyPassword(generated.password ?? '', row?.passwordHash ?? '')).toBe(true);

    await bdb.db.delete(users);
    await bootstrapAdmin(bdb.db, testConfig(), silentLogger(), now, { password: CHOSEN });
    const [explicit] = await bdb.db.select().from(users).where(eq(users.email, ADMIN_EMAIL));
    expect(explicit?.mustChangePassword).toBe(false);
  });

  it('with OIDC and no named bootstrap admin, still creates a local admin once', async () => {
    await bdb.db.delete(users);
    const config = testConfig({
      oidc: {
        issuer: 'https://login.acme.test',
        clientId: 'c',
        clientSecret: '',
        allowedDomains: [],
      },
      bootstrapAdmin: undefined,
    });
    expect((await bootstrapAdmin(bdb.db, config, silentLogger(), now)).created).toBe(true);
    expect((await bootstrapAdmin(bdb.db, config, silentLogger(), now)).created).toBe(false);

    await bdb.db.delete(users);
    const named = testConfig({ ...config, bootstrapAdmin: 'Boss@Acme.test' });
    const res = await bootstrapAdmin(bdb.db, named, silentLogger(), now);
    expect(res).toMatchObject({ created: true, email: 'boss@acme.test' });
    const [boss] = await bdb.db.select().from(users);
    expect(boss?.passwordHash).toBeNull();
  });
});

describe('users directory', () => {
  it('lets every role read emails and roles, and nothing else', async () => {
    const created = await h.request('POST', '/api/v1/tokens', {
      cookie: h.adminCookie,
      body: { name: 'directory-viewer', role: 'viewer', reason },
    });
    expect(created.statusCode, created.body).toBe(201);
    const token = created.json<{ secret: string }>().secret;

    const res = await h.request('GET', '/api/v1/users/directory', { token });
    expect(res.statusCode, res.body).toBe(200);
    const entries = res.json<Record<string, unknown>[]>();
    expect(entries.map((e) => e.email)).toContain(ADMIN_EMAIL);
    for (const e of entries) expect(Object.keys(e).sort()).toEqual(['email', 'id', 'role']);

    const full = await h.request('GET', '/api/v1/users', { token });
    expect(full.statusCode).toBe(403);
    expect((await h.request('GET', '/api/v1/users/directory')).statusCode).toBe(401);
  });
});

describe('the sign-in page recovery hint', () => {
  afterAll(() => {
    h.ctx.config.evaluation = true;
  });

  it('names the bootstrap local admin to a signed-out visitor in evaluation mode only', async () => {
    const signedOut = await h.request('GET', '/api/v1/auth/me');
    expect(signedOut.json<MeResponse>()).toMatchObject({
      user: null,
      evaluation: true,
      evaluationAdminEmail: ADMIN_EMAIL,
    });
    h.ctx.config.evaluation = false;
    const production = await h.request('GET', '/api/v1/auth/me');
    expect(production.json<MeResponse>()).toMatchObject({
      user: null,
      evaluation: false,
      evaluationAdminEmail: null,
    });
    expect(production.body).not.toContain('@');
  });
});
