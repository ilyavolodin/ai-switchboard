import type { FastifyInstance } from 'fastify';

import {
  reasonedBody,
  type ApprovalHistoryQuery,
  type ApproveResponse,
  type Reasoned,
} from '../../contract/index.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import { approvalHistory, approvalRules, pendingApprovals } from '../read/approvals.js';
import { allow } from './options.js';

export function registerApprovalRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/v1/approvals', allow('viewer'), async () => pendingApprovals(ctx));
  app.get<{ Querystring: ApprovalHistoryQuery }>(
    '/api/v1/approvals/history',
    allow('viewer'),
    async (req) => approvalHistory(ctx, req.query),
  );
  app.get('/api/v1/approvals/rules', allow('viewer'), async () => approvalRules(ctx));

  app.post<{ Params: { batchId: string }; Body: Reasoned }>(
    '/api/v1/approvals/:batchId/approve',
    allow('operator', reasonedBody),
    async (req): Promise<ApproveResponse> =>
      ctx.pipeline.approve(req.params.batchId, changeMeta(req, ctx.clock)),
  );
  app.post<{ Params: { batchId: string }; Body: Reasoned }>(
    '/api/v1/approvals/:batchId/reject',
    allow('operator', reasonedBody),
    async (req, reply) => {
      await ctx.pipeline.reject(req.params.batchId, changeMeta(req, ctx.clock));
      return reply.code(204).send();
    },
  );
}
