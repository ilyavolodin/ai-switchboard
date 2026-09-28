import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { evaluationAdminEmail } from '../../auth/bootstrap.js';
import { generatePassword, hashPassword, verifyPassword } from '../../auth/crypto.js';
import { actorOf, requireRole } from '../../auth/fastify.js';
import { OIDC_FLOW_COOKIE, OidcError } from '../../auth/oidc.js';
import { PASSWORD_MAX_LENGTH, passwordProblem } from '../../auth/password-policy.js';
import {
  createSession,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../../auth/sessions.js';
import {
  AttemptThrottle,
  emailKey,
  ipKey,
  MAX_FAILURES_PER_EMAIL,
  MAX_FAILURES_PER_IP,
  MAX_FAILURES_PER_PASSWORD_CHANGE,
  type ThrottleLimit,
} from '../../auth/throttle.js';
import { users } from '../../db/schema.js';
import { storePassword } from '../../services/users.js';
import type { ApiContext } from '../context.js';
import type { ChangePasswordRequest, LocalLoginRequest, MeResponse, UserDTO } from '../contract.js';
import { badRequest, conflict, HttpError } from '../errors.js';

export function toUserDTO(row: typeof users.$inferSelect): UserDTO {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    hasPassword: row.passwordHash !== null,
    hasOidc: row.oidcSubject !== null,
    mustChangePassword: row.mustChangePassword,
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

  const issuerHost = (): string | null => {
    if (!ctx.oidc) return null;
    try {
      return new URL(ctx.oidc.issuer).host;
    } catch {
      return ctx.oidc.issuer;
    }
  };

  const me = async (userId: string | undefined, restricted: boolean): Promise<MeResponse> => {
    const row = userId ? (await db.select().from(users).where(eq(users.id, userId)))[0] : undefined;
    return {
      user: row ? toUserDTO(row) : null,
      authMode: ctx.oidc ? 'oidc' : 'local',
      oidcConfigured: ctx.oidc !== undefined,
      oidcIssuer: issuerHost(),
      evaluation: config.evaluation,
      mustChangePassword: row !== undefined && restricted,
      evaluationAdminEmail: await evaluationAdminEmail(db, config),
    };
  };

  app.get('/api/v1/auth/me', async (req) =>
    me(req.user?.id, req.user?.passwordChangeRequired ?? false),
  );

  // Counted in Postgres, so the limits hold across replicas (a client cannot spread its guesses).
  const attempts = new AttemptThrottle(db, clock);
  const throttled = async (reply: FastifyReply, limits: ThrottleLimit[]): Promise<void> => {
    const decision = await attempts.check(limits);
    if (decision.allowed) return;
    void reply.header('Retry-After', String(decision.retryAfterSeconds));
    const wait =
      decision.retryAfterSeconds < 60
        ? `${decision.retryAfterSeconds} seconds`
        : `${Math.ceil(decision.retryAfterSeconds / 60)} minutes`;
    throw new HttpError(429, 'too_many_attempts', `Too many attempts; try again in ${wait}.`);
  };
  // Compared against when the email has no password, so a miss costs as long as a wrong password
  // and the response time does not tell which emails have accounts.
  let decoy: Promise<string> | undefined;

  app.post<{ Body: LocalLoginRequest }>(
    '/api/v1/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', maxLength: 320 },
            // Longer than any password the policy accepts; bounds the scrypt input.
            password: { type: 'string', maxLength: PASSWORD_MAX_LENGTH * 4 },
          },
        },
      },
    },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const byIp = ipKey(req.ip);
      const byEmail = emailKey(email);
      await throttled(reply, [
        { key: byIp, max: MAX_FAILURES_PER_IP },
        { key: byEmail, max: MAX_FAILURES_PER_EMAIL },
      ]);
      const [row] = await db
        .select()
        .from(users)
        .where(and(eq(users.email, email), isNotNull(users.passwordHash)));
      decoy ??= hashPassword(generatePassword());
      const ok = await verifyPassword(req.body.password, row?.passwordHash ?? (await decoy));
      if (!row || !ok) {
        await attempts.fail([byIp, byEmail]);
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
      }
      // The account's counter resets; the address keeps its count, so one known password does
      // not buy an address fresh guesses at other accounts.
      await attempts.succeed([byEmail]);
      const token = await createSession(db, row.id, 'password', clock.now());
      void reply.setCookie(SESSION_COOKIE, token, cookieOptions);
      return me(row.id, row.mustChangePassword);
    },
  );

  app.post<{ Body: ChangePasswordRequest }>(
    '/api/v1/auth/password',
    {
      preHandler: requireRole('viewer'),
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string' },
            newPassword: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.user;
      const token = req.cookies[SESSION_COOKIE];
      if (user?.via !== 'session' || !token)
        throw new HttpError(403, 'forbidden', 'Change a password from a signed-in session.');
      const key = `password:${user.id}`;
      await throttled(reply, [{ key, max: MAX_FAILURES_PER_PASSWORD_CHANGE }]);
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      if (!row?.passwordHash)
        throw conflict('This account has no password; ask an admin to set one.');
      if (!(await verifyPassword(req.body.currentPassword, row.passwordHash))) {
        await attempts.fail([key]);
        // 400, not 401: the session is fine, only the confirmation failed.
        throw new HttpError(400, 'invalid_credentials', 'The current password is incorrect.');
      }
      await attempts.succeed([key]);
      const problem = passwordProblem(req.body.newPassword, row.email);
      if (problem) throw badRequest(problem);
      if (req.body.newPassword === req.body.currentPassword)
        throw badRequest('Choose a password different from the current one.');
      const now = clock.now();
      await db.transaction((tx) =>
        storePassword(tx, row.id, req.body.newPassword, {
          temporary: false,
          keepToken: token,
          field: 'password',
          audit: { actor: actorOf(req), reason: 'changed own password', at: now },
        }),
      );
      return me(row.id, false);
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
        if (row.oidcSubject !== null && row.oidcSubject !== identity.subject) {
          // The email was bound to another subject at the issuer; never re-bind silently.
          throw new OidcError('This account is linked to a different identity; ask an admin.');
        }
        if (row.oidcSubject === null) {
          await db.update(users).set({ oidcSubject: identity.subject }).where(eq(users.id, row.id));
        }
        const token = await createSession(db, row.id, 'oidc', clock.now());
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
