import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { verifyPassword } from '../../auth/crypto.js';
import { actorOf, requireRole } from '../../auth/fastify.js';
import { OIDC_FLOW_COOKIE, OidcError } from '../../auth/oidc.js';
import {
  createSession,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../../auth/sessions.js';
import { users } from '../../db/schema.js';
import type { ApiContext } from '../context.js';
import type { LocalLoginRequest, MeResponse, UserDTO } from '../contract.js';
import { HttpError } from '../errors.js';

export function toUserDTO(row: typeof users.$inferSelect): UserDTO {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, clock, config } = ctx;
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.secureCookies,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };

  const me = async (userId: string | undefined): Promise<MeResponse> => {
    const row = userId ? (await db.select().from(users).where(eq(users.id, userId)))[0] : undefined;
    return {
      user: row ? toUserDTO(row) : null,
      authMode: ctx.oidc ? 'oidc' : 'local',
      oidcConfigured: ctx.oidc !== undefined,
      evaluation: config.evaluation,
    };
  };

  app.get('/api/v1/auth/me', async (req) => me(req.user?.id));

  const failures = new Map<string, { n: number; until: number }>();

  app.post<{ Body: LocalLoginRequest }>(
    '/api/v1/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: { email: { type: 'string' }, password: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      if (ctx.oidc)
        throw new HttpError(
          404,
          'not_found',
          'Local sign-in is disabled; this installation uses OIDC.',
        );
      const key = req.ip;
      const now = clock.now().getTime();
      const f = failures.get(key);
      if (f && f.until > now)
        throw new HttpError(429, 'too_many_attempts', 'Too many attempts; wait a minute.');
      const email = req.body.email.trim().toLowerCase();
      const [row] = await db
        .select()
        .from(users)
        .where(and(eq(users.email, email), isNotNull(users.passwordHash)));
      const ok = row?.passwordHash
        ? await verifyPassword(req.body.password, row.passwordHash)
        : false;
      if (!row || !ok) {
        const n = (f?.n ?? 0) + 1;
        failures.set(key, { n, until: n >= 5 ? now + 60_000 : 0 });
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
      }
      failures.delete(key);
      const token = await createSession(db, row.id, clock.now());
      void reply.setCookie(SESSION_COOKIE, token, cookieOptions);
      return me(row.id);
    },
  );

  app.get('/api/v1/auth/oidc/start', async (_req, reply) => {
    if (!ctx.oidc) throw new HttpError(404, 'not_found', 'OIDC is not configured.');
    const start = await ctx.oidc.start(clock.now());
    void reply.setCookie(OIDC_FLOW_COOKIE, start.cookie, { ...cookieOptions, maxAge: 600 });
    return reply.redirect(start.url);
  });

  app.get('/api/v1/auth/oidc/callback', async (req, reply) => {
    if (!ctx.oidc) throw new HttpError(404, 'not_found', 'OIDC is not configured.');
    const current = new URL(req.url, config.publicUrl);
    let target: string;
    try {
      const identity = await ctx.oidc.callback(current, req.cookies[OIDC_FLOW_COOKIE], clock.now());
      void reply.clearCookie(OIDC_FLOW_COOKIE, { path: '/' });
      const [row] = await db.select().from(users).where(eq(users.email, identity.email));
      if (!row) {
        target = `/no-access?email=${encodeURIComponent(identity.email)}`;
      } else {
        if (row.oidcSubject !== identity.subject) {
          await db.update(users).set({ oidcSubject: identity.subject }).where(eq(users.id, row.id));
        }
        const token = await createSession(db, row.id, clock.now());
        void reply.setCookie(SESSION_COOKIE, token, cookieOptions);
        target = '/';
      }
    } catch (err) {
      req.log.warn({ err }, 'oidc callback failed');
      const message = err instanceof OidcError ? err.message : 'Sign-in failed.';
      target = `/login?error=${encodeURIComponent(message)}`;
    }
    return reply.redirect(target);
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await revokeSession(db, token);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/whoami', { preHandler: requireRole('viewer') }, (req) => ({
    actor: actorOf(req),
  }));
}
