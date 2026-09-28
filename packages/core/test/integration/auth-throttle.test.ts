import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pruneLoginAttempts } from '../../src/auth/throttle.js';
import { loginAttempts } from '../../src/db/schema.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, createApiHarness, type ApiHarness } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

/**
 * The sign-in throttle is counted in Postgres: two replicas (two servers over one database) see
 * each other's failures, per client address and per account.
 */

let tdb: TestDatabase;
let a: ApiHarness;
let b: ApiHarness;

beforeAll(async () => {
  tdb = await createTestDatabase();
  a = await createApiHarness(tdb);
  b = await createApiHarness(tdb);
});

afterAll(async () => {
  await a.close();
  await b.close();
  await tdb.destroy();
});

const login = (h: ApiHarness, email: string, password: string, ip: string) =>
  h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
    remoteAddress: ip,
  });

describe('sign-in throttle across replicas', () => {
  it('locks an account after five failures spread over two replicas, from any address', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(i % 2 === 0 ? a : b, ADMIN_EMAIL, 'wrong-guess', `10.0.1.${i}`);
      expect(res.statusCode, res.body).toBe(401);
    }
    // Even the right password is refused while the account is locked, on either replica.
    for (const h of [a, b]) {
      const res = await login(h, ` ${ADMIN_EMAIL.toUpperCase()} `, ADMIN_PASSWORD, '10.0.1.99');
      expect(res.statusCode, res.body).toBe(429);
      expect(res.json<{ error: string }>().error).toBe('too_many_attempts');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(300);
    }
    // The table names no address in clear.
    const keys = (await tdb.db.select().from(loginAttempts)).map((r) => r.key);
    expect(keys.join(' ')).not.toContain(ADMIN_EMAIL);

    // After the window the account signs in again, and success resets its counter.
    a.clock.advanceMinutes(6);
    b.clock.advanceMinutes(6);
    const ok = await login(a, ADMIN_EMAIL, ADMIN_PASSWORD, '10.0.1.99');
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('locks an address after ten failures across replicas, whatever the emails', async () => {
    const ip = '10.0.2.1';
    for (let i = 0; i < 10; i++) {
      const res = await login(i < 5 ? a : b, `nobody-${i}@example.com`, 'wrong-guess', ip);
      expect(res.statusCode, res.body).toBe(401);
    }
    const locked = await login(a, ADMIN_EMAIL, ADMIN_PASSWORD, ip);
    expect(locked.statusCode).toBe(429);
    // Another address is not affected.
    const other = await login(b, ADMIN_EMAIL, ADMIN_PASSWORD, '10.0.2.2');
    expect(other.statusCode, other.body).toBe(200);
  });

  it('prunes attempts no window counts any more', async () => {
    expect((await tdb.db.select().from(loginAttempts)).length).toBeGreaterThan(0);
    await pruneLoginAttempts(tdb.db, new Date(a.clock.now().getTime() + 2 * 60 * 60_000));
    expect(await tdb.db.select().from(loginAttempts)).toEqual([]);
  });
});
