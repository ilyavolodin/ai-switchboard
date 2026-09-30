import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OidcClient } from '../../src/auth/oidc.js';
import { auditLog, users } from '../../src/db/schema.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, createApiHarness, type ApiHarness } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const CLIENT_ID = 'switchboard';
const CLIENT_SECRET = 'fixture-client-secret';

/** A tiny OpenID provider: discovery, JWKS, and a token endpoint that checks PKCE. */
interface FakeIssuer {
  server: Server;
  setBase(url: string): void;
  /** `emailVerified: undefined` leaves the claim out of the ID token. */
  authorize(params: URLSearchParams, email: string, emailVerified?: boolean): string;
}

function fakeIssuer(): FakeIssuer {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    {
      challenge: string;
      nonce: string;
      email: string;
      emailVerified: boolean | undefined;
      redirectUri: string;
    }
  >();
  let base = '';
  const b64 = (v: object | Buffer): string =>
    (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
  const sign = (payload: object): string => {
    const input = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64(payload)}`;
    const sig = createSign('RSA-SHA256').update(input).sign(privateKey);
    return `${input}.${b64(sig)}`;
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    const json = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
      return;
    }
    if (url.pathname === '/jwks') {
      json(200, { keys: [jwk] });
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const entry = codes.get(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (entry?.challenge !== challenge) {
          json(400, { error: 'invalid_grant' });
          return;
        }
        codes.delete(form.get('code') ?? '');
        const now = Math.floor(Date.now() / 1000);
        json(200, {
          access_token: 'at',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: sign({
            iss: base,
            sub: `sub-${entry.email}`,
            aud: CLIENT_ID,
            iat: now,
            exp: now + 300,
            nonce: entry.nonce,
            email: entry.email,
            ...(entry.emailVerified === undefined ? {} : { email_verified: entry.emailVerified }),
          }),
        });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  return {
    server,
    setBase: (url) => {
      base = url;
    },
    authorize: (params, email, emailVerified) => {
      const code = randomBytes(12).toString('hex');
      codes.set(code, {
        challenge: params.get('code_challenge') ?? '',
        nonce: params.get('nonce') ?? '',
        email,
        emailVerified,
        redirectUri: params.get('redirect_uri') ?? '',
      });
      return code;
    },
  };
}

let tdb: TestDatabase;
let h: ApiHarness;
let issuer: FakeIssuer;
let issuerBase = '';

beforeAll(async () => {
  tdb = await createTestDatabase();
  h = await createApiHarness(tdb);
  issuer = fakeIssuer();
  await new Promise<void>((resolve) => issuer.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(issuer.server.address() as AddressInfo).port}`;
  issuer.setBase(base);
  issuerBase = base;
  h.ctx.oidc = oidcClient(base);
  await tdb.db.insert(users).values({ email: 'alice@acme.test', role: 'operator' });
});

afterAll(async () => {
  issuer.server.close();
  await h.close();
  await tdb.destroy();
});

function oidcClient(base: string, options: { trustUnverifiedEmail?: boolean } = {}): OidcClient {
  return new OidcClient(
    {
      issuer: base,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      allowedDomains: ['acme.test'],
      ...options,
    },
    'http://switchboard.test/api/v1/auth/oidc/callback',
    'cookie-key',
    { allowInsecure: true },
  );
}

async function signIn(
  email: string,
  emailVerified: boolean | 'absent' = true,
): Promise<{ location: string; cookie: string | undefined }> {
  const start = await h.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
  expect(start.statusCode).toBe(302);
  const authUrl = new URL(start.headers.location!);
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
  const flowCookie = String(start.headers['set-cookie']).split(';')[0] ?? '';
  const code = issuer.authorize(
    authUrl.searchParams,
    email,
    emailVerified === 'absent' ? undefined : emailVerified,
  );
  const cb = await h.app.inject({
    method: 'GET',
    url: `/api/v1/auth/oidc/callback?code=${code}&state=${authUrl.searchParams.get('state') ?? ''}`,
    headers: { cookie: flowCookie },
  });
  expect(cb.statusCode).toBe(302);
  const set = cb.headers['set-cookie'];
  const session = (Array.isArray(set) ? set : [set]).find((c) => c?.startsWith('sb_session='));
  return { location: cb.headers.location!, cookie: session?.split(';')[0] };
}

describe('OIDC sign-in', () => {
  it('signs in a known user through the authorization-code flow with PKCE', async () => {
    const { location, cookie } = await signIn('alice@acme.test');
    expect(location).toBe('/');
    expect(cookie).toBeDefined();
    const me = await h.request('GET', '/api/v1/auth/me', { cookie: cookie! });
    expect(me.json<{ user: { email: string; role: string } }>().user).toMatchObject({
      email: 'alice@acme.test',
      role: 'operator',
    });
  });

  it('audits binding the issuer subject on the first sign-in, once', async () => {
    const [alice] = await tdb.db.select().from(users).where(eq(users.email, 'alice@acme.test'));
    expect(alice?.oidcSubject).not.toBeNull();
    const bound = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, alice!.id), eq(auditLog.field, 'oidc_subject')));
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({
      actor: 'alice@acme.test',
      scope: 'user',
      before: null,
      after: alice!.oidcSubject,
      reason: 'first OIDC sign-in',
    });
    await signIn('alice@acme.test');
    const again = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, alice!.id), eq(auditLog.field, 'oidc_subject')));
    expect(again).toHaveLength(1);
  });

  it('refuses an email already bound to another subject, and never re-binds it', async () => {
    await tdb.db.insert(users).values({
      email: 'carol@acme.test',
      role: 'viewer',
      oidcSubject: 'someone-else',
    });
    const { location, cookie } = await signIn('carol@acme.test');
    expect(decodeURIComponent(location)).toMatch(/linked to a different identity/);
    expect(cookie).toBeUndefined();
    const [carol] = await tdb.db.select().from(users).where(eq(users.email, 'carol@acme.test'));
    expect(carol?.oidcSubject).toBe('someone-else');
  });

  it('sends a valid token for an unknown email to the ask-an-admin page', async () => {
    const { location, cookie } = await signIn('bob@acme.test');
    expect(location).toBe('/no-access?email=bob%40acme.test');
    expect(cookie).toBeUndefined();
  });

  it('enforces the allowed-domain list', async () => {
    const { location, cookie } = await signIn('mallory@evil.test');
    expect(location).toMatch(/^\/login\?error=.*allowed%20domain/);
    expect(cookie).toBeUndefined();
  });

  it('refuses an email the issuer does not say is verified', async () => {
    await tdb.db.insert(users).values({ email: 'dave@acme.test', role: 'viewer' });
    for (const verified of [false, 'absent'] as const) {
      const { location, cookie } = await signIn('dave@acme.test', verified);
      expect(decodeURIComponent(location), String(verified)).toMatch(/not verified/);
      expect(cookie).toBeUndefined();
    }
    const [dave] = await tdb.db.select().from(users).where(eq(users.email, 'dave@acme.test'));
    expect(dave?.oidcSubject).toBeNull();
  });

  it('with trustUnverifiedEmail, signs in an unverified email but never links a password account', async () => {
    const strict = h.ctx.oidc;
    h.ctx.oidc = oidcClient(issuerBase, { trustUnverifiedEmail: true });
    try {
      const open = await signIn('dave@acme.test', 'absent');
      expect(open.location).toBe('/');
      expect(open.cookie).toBeDefined();

      await tdb.db
        .insert(users)
        .values({ email: 'erin@acme.test', role: 'admin', passwordHash: 'scrypt$1$1$1$x$y' });
      const refused = await signIn('erin@acme.test', 'absent');
      expect(decodeURIComponent(refused.location)).toMatch(/password/);
      expect(refused.cookie).toBeUndefined();
      const [erin] = await tdb.db.select().from(users).where(eq(users.email, 'erin@acme.test'));
      expect(erin?.oidcSubject).toBeNull();

      const verified = await signIn('erin@acme.test', true);
      expect(verified.location).toBe('/');
    } finally {
      h.ctx.oidc = strict;
    }
  });

  it('rejects a callback without the signed flow cookie', async () => {
    const cb = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/callback?code=x&state=y',
    });
    expect(cb.headers.location).toMatch(/^\/login\?error=/);
  });

  it('keeps local password sign-in alongside OIDC', async () => {
    const wrong = await h.request('POST', '/api/v1/auth/login', {
      body: { email: ADMIN_EMAIL, password: 'x' },
    });
    expect(wrong.statusCode).toBe(401);
    const cookie = await h.login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const me = await h.request('GET', '/api/v1/auth/me', { cookie });
    expect(me.json<{ authMode: string; user: { email: string } }>()).toMatchObject({
      authMode: 'oidc',
      user: { email: ADMIN_EMAIL },
    });
  });

  it('does not restrict an OIDC session when the account also has a temporary password', async () => {
    await tdb.db
      .update(users)
      .set({ passwordHash: 'scrypt$1$1$1$x$y', mustChangePassword: true })
      .where(eq(users.email, 'alice@acme.test'));
    const { cookie } = await signIn('alice@acme.test');
    const res = await h.request('GET', '/api/v1/processes', { cookie: cookie! });
    expect(res.statusCode).toBe(200);
  });
});
