import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import type { Role } from '../domain/status.js';
import { roleAtLeast } from './crypto.js';
import { SESSION_COOKIE, userForApiToken, userForSession, type AuthUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export const PASSWORD_CHANGE_ALLOWED: ReadonlySet<string> = new Set([
  'GET /api/v1/auth/me',
  'POST /api/v1/auth/password',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/login',
  'GET /api/v1/auth/oidc/start',
  'GET /api/v1/auth/oidc/callback',
]);

export function registerAuth(app: FastifyInstance, db: Db, clock: Clock): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      req.user = await userForApiToken(db, header.slice(7).trim(), clock.now());
      return;
    }
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie) req.user = await userForSession(db, cookie, clock.now());
    if (req.user?.passwordChangeRequired) {
      const path = req.url.split('?')[0] ?? req.url;
      if (!PASSWORD_CHANGE_ALLOWED.has(`${req.method} ${path}`)) {
        return reply.code(403).send({
          error: 'password_change_required',
          message: 'Change your temporary password to continue.',
        });
      }
    }
  });
}

function deny(reply: FastifyReply, status: 401 | 403, message: string): FastifyReply {
  return reply
    .code(status)
    .send({ error: status === 401 ? 'unauthenticated' : 'forbidden', message });
}

export function requireRole(role: Role): preHandlerHookHandler {
  return (req: FastifyRequest, reply: FastifyReply, done) => {
    if (!req.user) {
      void deny(reply, 401, 'Sign in to continue.');
      return;
    }
    if (!roleAtLeast(req.user.role, role)) {
      void deny(
        reply,
        403,
        `This action needs the ${role} role; you are signed in as ${req.user.role}.`,
      );
      return;
    }
    done();
  };
}

export function actorOf(req: FastifyRequest): string {
  if (!req.user) return 'anonymous';
  return req.user.via === 'session' ? req.user.email : `${req.user.email} (${req.user.via})`;
}
