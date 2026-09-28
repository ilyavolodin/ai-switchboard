import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GlobalSettings, MeResponse, UserDTO } from '../../src/api/contract.js';
import { auditLog } from '../../src/db/schema.js';
import { createApiHarness, type ApiHarness } from '../helpers/api.js';
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

async function setRequireReasons(value: boolean, reason = 'toggle reasons'): Promise<number> {
  const res = await h.request('PUT', '/api/v1/settings', {
    cookie: h.adminCookie,
    body: { settings: { requireReasons: value }, reason },
  });
  return res.statusCode;
}

async function me(): Promise<MeResponse> {
  return (await h.request('GET', '/api/v1/auth/me', { cookie: h.adminCookie })).json<MeResponse>();
}

describe('requireReasons (default on)', () => {
  it('is on by default and reported by /settings and /auth/me', async () => {
    const settings = await h.request('GET', '/api/v1/settings', { cookie: h.adminCookie });
    expect(settings.json<GlobalSettings>().requireReasons).toBe(true);
    expect((await me()).requireReasons).toBe(true);
  });

  it('refuses a change with an empty or missing reason', async () => {
    const empty = await h.request('POST', '/api/v1/users', {
      cookie: h.adminCookie,
      body: { email: 'a@acme.test', role: 'viewer', reason: '  ' },
    });
    expect(empty.statusCode).toBe(400);
    const missing = await h.request('POST', '/api/v1/users', {
      cookie: h.adminCookie,
      body: { email: 'a@acme.test', role: 'viewer' },
    });
    expect(missing.statusCode).toBe(400);
    expect(await setRequireReasons(false, '')).toBe(400);
  });

  it('is admin-only to change, and the change is audited', async () => {
    const created = await h.request('POST', '/api/v1/tokens', {
      cookie: h.adminCookie,
      body: { name: 'op', role: 'operator', reason: 'operator token' },
    });
    const { secret } = created.json<{ secret: string }>();
    const denied = await h.request('PUT', '/api/v1/settings', {
      token: secret,
      body: { settings: { requireReasons: false }, reason: 'try' },
    });
    expect(denied.statusCode).toBe(403);
    const invalid = await h.request('PUT', '/api/v1/settings', {
      cookie: h.adminCookie,
      body: { settings: { requireReasons: 'no' }, reason: 'bad value' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('requireReasons off', () => {
  it('accepts a change without a reason and audits "(no reason given)"', async () => {
    expect(await setRequireReasons(false, 'team prefers no prompts')).toBe(200);
    const [toggle] = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.scope, 'settings'), eq(auditLog.field, 'requireReasons')));
    expect(toggle).toMatchObject({ before: true, after: false, reason: 'team prefers no prompts' });
    // Applied at once on the replica that wrote it.
    expect((await me()).requireReasons).toBe(false);

    const created = await h.request('POST', '/api/v1/users', {
      cookie: h.adminCookie,
      body: { email: 'noreason@acme.test', role: 'viewer' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const user = created.json<UserDTO>();
    const blank = await h.request('PUT', `/api/v1/users/${user.id}`, {
      cookie: h.adminCookie,
      body: { role: 'operator', reason: '   ' },
    });
    expect(blank.statusCode, blank.body).toBe(200);
    // A bodiless DELETE works too.
    const removed = await h.request('DELETE', `/api/v1/users/${user.id}`, {
      cookie: h.adminCookie,
    });
    expect(removed.statusCode, removed.body).toBe(204);

    const rows = await tdb.db.select().from(auditLog).where(eq(auditLog.targetId, user.id));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(r.reason).toBe('(no reason given)');
  });

  it('still records a reason that is given', async () => {
    const created = await h.request('POST', '/api/v1/users', {
      cookie: h.adminCookie,
      body: { email: 'withreason@acme.test', role: 'viewer', reason: 'new hire' },
    });
    const user = created.json<UserDTO>();
    const [row] = await tdb.db.select().from(auditLog).where(eq(auditLog.targetId, user.id));
    expect(row?.reason).toBe('new hire');
  });

  it('turning it back on needs no reason, and then reasons are required again', async () => {
    expect(await setRequireReasons(true, '')).toBe(200);
    expect((await me()).requireReasons).toBe(true);
    const missing = await h.request('POST', '/api/v1/users', {
      cookie: h.adminCookie,
      body: { email: 'again@acme.test', role: 'viewer' },
    });
    expect(missing.statusCode).toBe(400);
  });

  it('does not touch the sign-in routes', async () => {
    expect(await setRequireReasons(false, 'off for sign-in check')).toBe(200);
    const res = await h.request('POST', '/api/v1/auth/login', {
      body: { email: 'nobody@acme.test', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(await setRequireReasons(true)).toBe(200);
  });
});
