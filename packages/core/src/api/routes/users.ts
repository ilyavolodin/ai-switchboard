import type { FastifyInstance } from 'fastify';

import {
  changeUserRole,
  createUser,
  deleteUser,
  removeUserPassword,
  revokeSessionsOf,
  setTemporaryPassword,
} from '../../services/users.js';
import { createToken, revokeToken, tokensOf } from '../../services/tokens.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import {
  createApiTokenBody,
  createUserBody,
  reasonedBody,
  setPasswordBody,
  updateUserBody,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
  type CreateUserRequest,
  type Reasoned,
  type SetPasswordRequest,
  type UpdateUserRequest,
} from '../../contract/index.js';
import { HttpError } from '../errors.js';
import { toTokenDTO, toUserDTO, userDirectory, userList } from '../read/users.js';
import { allow } from './options.js';

export function registerUserRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, clock } = ctx;

  app.get('/api/v1/users', allow('admin'), async () => userList(ctx));
  app.get('/api/v1/users/directory', allow('viewer'), async () => userDirectory(ctx));

  app.post<{ Body: CreateUserRequest }>(
    '/api/v1/users',
    allow('admin', createUserBody),
    async (req, reply) => {
      const { email, role, password } = req.body;
      const row = await createUser(db, { email, role, password }, changeMeta(req, clock));
      return reply.code(201).send(toUserDTO(row));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateUserRequest }>(
    '/api/v1/users/:id',
    allow('admin', updateUserBody),
    async (req) =>
      toUserDTO(await changeUserRole(db, req.params.id, req.body.role, changeMeta(req, clock))),
  );

  app.delete<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/users/:id',
    allow('admin'),
    async (req, reply) => {
      await deleteUser(db, req.params.id, req.user?.id, changeMeta(req, clock));
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { id: string }; Body: SetPasswordRequest }>(
    '/api/v1/users/:id/password',
    allow('admin', setPasswordBody),
    async (req) => {
      const meta = changeMeta(req, clock);
      return toUserDTO(
        await setTemporaryPassword(db, req.params.id, req.body.password, req.user?.id, meta),
      );
    },
  );

  app.delete<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/users/:id/password',
    allow('admin'),
    async (req) => {
      const meta = changeMeta(req, clock);
      return toUserDTO(await removeUserPassword(db, req.params.id, ctx.oidc !== undefined, meta));
    },
  );

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/users/:id/sessions/revoke',
    allow('admin', reasonedBody),
    async (req, reply) => {
      await revokeSessionsOf(db, req.params.id, changeMeta(req, clock));
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/tokens', allow('viewer'), async (req) =>
    (await tokensOf(db, req.user?.id ?? '')).map(toTokenDTO),
  );

  app.post<{ Body: CreateApiTokenRequest }>(
    '/api/v1/tokens',
    allow('viewer', createApiTokenBody),
    async (req, reply): Promise<CreateApiTokenResponse> => {
      const meta = changeMeta(req, clock);
      if (!req.user) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
      const { row, secret } = await createToken(
        db,
        req.user,
        { name: req.body.name, role: req.body.role },
        meta,
      );
      void reply.code(201);
      return { token: toTokenDTO(row), secret };
    },
  );

  app.delete<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/tokens/:id',
    allow('viewer'),
    async (req, reply) => {
      await revokeToken(db, req.params.id, req.user, changeMeta(req, clock));
      return reply.code(204).send();
    },
  );
}
