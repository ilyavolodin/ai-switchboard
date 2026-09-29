import type { FastifyInstance } from 'fastify';

import type { ApiContext } from '../context.js';
import { providerSecrets } from '../read/secrets.js';
import { registerAdminInstanceRoutes } from './instance-lifecycle.js';
import { allow } from './options.js';

export function registerSecretProviderRoutes(app: FastifyInstance, ctx: ApiContext): void {
  registerAdminInstanceRoutes(app, ctx, 'secret_provider', '/api/v1/secret-providers');

  // Names only, never a value. Admin only: secret names map out the credentials a deployment holds.
  app.get<{ Params: { id: string } }>(
    '/api/v1/secret-providers/:id/secrets',
    allow('admin'),
    async (req) => providerSecrets(ctx, req.params.id),
  );
}
