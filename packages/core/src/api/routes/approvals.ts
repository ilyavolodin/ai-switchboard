import type { FastifyInstance } from 'fastify';

import { actorOf } from '../../auth/fastify.js';
import type { ApiContext } from '../context.js';
import {
  reasonedBody,
  type ApprovalHistoryQuery,
  type ApproveResponse,
  type Reasoned,
} from '../contract.js';
import { requireReason } from '../errors.js';
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
    async (req): Promise<ApproveResponse> => {
      const reason = requireReason(req.body);
      return ctx.pipeline.approve(req.params.batchId, actorOf(req), reason);
    },
  );
  app.post<{ Params: { batchId: string }; Body: Reasoned }>(
    '/api/v1/approvals/:batchId/reject',
    allow('operator', reasonedBody),
    async (req, reply) => {
      const reason = requireReason(req.body);
      await ctx.pipeline.reject(req.params.batchId, actorOf(req), reason);
      return reply.code(204).send();
    },
  );
}
