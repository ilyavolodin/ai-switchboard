import type { FastifyInstance, FastifyReply } from 'fastify';

import { evaluationAdminEmail } from '../../auth/bootstrap.js';
import { generatePassword, hashPassword } from '../../auth/crypto.js';
import { actorOf, requireRole } from '../../auth/fastify.js';
import { OIDC_FLOW_COOKIE, OidcError } from '../../auth/oidc.js';
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
import { DomainError, isDomainError, unauthenticated } from '../../services/errors.js';
import {
  changeOwnPassword,
  getUser,
  passwordLogin,
  userForOidcIdentity,
} from '../../services/users.js';
import type { ApiContext } from '../context.js';
import {
  changePasswordBody,
  localLoginBody,
  type ChangePasswordRequest,
  type LocalLoginRequest,
  type MeResponse,
  type WhoAmIResponse,
} from '../../contract/index.js';
import { forbidden } from '../errors.js';
import { toUserDTO } from '../read/users.js';

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
    const row = userId ? await getUser(db, userId) : undefined;
    return {
      user: row ? toUserDTO(row) : null,
      authMode: ctx.oidc ? 'oidc' : 'local',
      oidcConfigured: ctx.oidc !== undefined,
      oidcIssuer: issuerHost(),
      evaluation: config.evaluation,
      mustChangePassword: row !== undefined && restricted,
      evaluationAdminEmail: await evaluationAdminEmail(db, config),
      requireReasons: await app.reasons.required(),
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
    throw new DomainError('too_many_attempts', `Too many attempts; try again in ${wait}.`);
  };
  let decoy: Promise<string> | undefined;
  const decoyHash = () => (decoy ??= hashPassword(generatePassword()));

  app.post<{ Body: LocalLoginRequest }>(
    '/api/v1/auth/login',
    { schema: { body: localLoginBody } },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const byIp = ipKey(req.ip);
      const byEmail = emailKey(email);
      await throttled(reply, [
        { key: byIp, max: MAX_FAILURES_PER_IP },
        { key: byEmail, max: MAX_FAILURES_PER_EMAIL },
      ]);
      const row = await passwordLogin(db, email, req.body.password, decoyHash);
      if (!row) {
        await attempts.fail([byIp, byEmail]);
        throw unauthenticated('Email or password is incorrect.', 'invalid_credentials');
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
    { preHandler: requireRole('viewer'), schema: { body: changePasswordBody } },
    async (req, reply) => {
      const user = req.user;
      const token = req.cookies[SESSION_COOKIE];
      if (user?.via !== 'session' || !token)
        throw forbidden('Change a password from a signed-in session.');
      const key = `password:${user.id}`;
      await throttled(reply, [{ key, max: MAX_FAILURES_PER_PASSWORD_CHANGE }]);
      const row = await changeOwnPassword(
        db,
        user.id,
        {
          currentPassword: req.body.currentPassword,
          newPassword: req.body.newPassword,
          keepToken: token,
        },
        { actor: actorOf(req), reason: 'changed own password', now: clock.now() },
        (ok) => (ok ? attempts.succeed([key]) : attempts.fail([key])),
      );
      return me(row.id, false);
    },
  );

  const oidcMissing = () => new DomainError('not_found', 'OIDC is not configured.');

  app.get('/api/v1/auth/oidc/start', async (_req, reply) => {
    if (!ctx.oidc) throw oidcMissing();
    const start = await ctx.oidc.start(clock.now());
    void reply.setCookie(OIDC_FLOW_COOKIE, start.cookie, { ...cookieOptions, maxAge: 600 });
    return reply.redirect(start.url);
  });

  app.get('/api/v1/auth/oidc/callback', async (req, reply) => {
    if (!ctx.oidc) throw oidcMissing();
    const current = new URL(req.url, config.publicUrl);
    let target: string;
    try {
      const identity = await ctx.oidc.callback(current, req.cookies[OIDC_FLOW_COOKIE], clock.now());
      void reply.clearCookie(OIDC_FLOW_COOKIE, { path: '/' });
      const row = await userForOidcIdentity(db, identity, clock.now());
      if (!row) {
        target = `/no-access?email=${encodeURIComponent(identity.email)}`;
      } else {
        const token = await createSession(db, row.id, 'oidc', clock.now());
        void reply.setCookie(SESSION_COOKIE, token, cookieOptions);
        target = '/';
      }
    } catch (err) {
      req.log.warn({ err }, 'oidc callback failed');
      const message =
        err instanceof OidcError || isDomainError(err) ? err.message : 'Sign-in failed.';
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

  app.get('/api/v1/auth/whoami', { preHandler: requireRole('viewer') }, (req): WhoAmIResponse => ({
    actor: actorOf(req),
  }));
}
