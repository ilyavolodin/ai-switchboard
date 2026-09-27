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

/** Resolve the caller from the session cookie or a bearer API token on every `/api` request. */
export function registerAuth(app: FastifyInstance, db: Db, clock: Clock): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      req.user = await userForApiToken(db, header.slice(7).trim(), clock.now());
      return;
    }
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie) req.user = await userForSession(db, cookie, clock.now());
  });
}

function deny(reply: FastifyReply, status: 401 | 403, message: string): FastifyReply {
  return reply
    .code(status)
    .send({ error: status === 401 ? 'unauthenticated' : 'forbidden', message });
}

/** preHandler: the caller must be signed in with at least `role`. */
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

/** The acting user's audit identity. */
export function actorOf(req: FastifyRequest): string {
  if (!req.user) return 'anonymous';
  return req.user.via === 'session' ? req.user.email : `${req.user.email} (${req.user.via})`;
}
