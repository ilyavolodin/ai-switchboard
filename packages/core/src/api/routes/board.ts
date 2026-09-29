import type { FastifyInstance } from 'fastify';

import type { ApiContext } from '../context.js';
import { board, statusStrip } from '../read/board.js';
import { allow } from './options.js';

export function registerBoardRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/v1/status', allow('viewer'), async () => statusStrip(ctx));
  app.get('/api/v1/board', allow('viewer'), async () => board(ctx));
}
