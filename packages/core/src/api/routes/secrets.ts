import type { FastifyInstance } from 'fastify';

import { requireRole } from '../../auth/fastify.js';
import type { ApiContext } from '../context.js';
import { providerSecrets } from '../read/secrets.js';

/**
 * Names only, never a value. Admin only: secret names map out the credentials a deployment
 * holds.
 */
export function registerSecretRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get<{ Params: { id: string } }>(
    '/api/v1/secret-providers/:id/secrets',
    { preHandler: requireRole('admin') },
    (req) => providerSecrets(ctx, req.params.id),
  );
}
