import type { RawRequest } from '@ai-switchboard/sdk';

import type {
  ApproveResponse,
  CronPreviewRequest,
  CronPreviewResponse,
  FilterPreviewRequest,
  FilterPreviewResponse,
  InputPreviewRequest,
  InputPreviewResponse,
  EventIdsResponse,
  RunNowRequest,
  RunNowResponse,
  SettledRunStatus,
  TraceResponse,
} from '../contract/index.js';
import type { ChangeMeta } from '../services/audit.js';
import type { IngressOutcome } from '../services/pipeline/outcomes.js';

/**
 * Declared here so the HTTP layer depends on a port, not on the pipeline's internals. Every
 * mutating call takes the request's `ChangeMeta`, and the pipeline audits it.
 */
export interface PipelinePort {
  ingestPush(sourceId: string, req: RawRequest): Promise<IngressOutcome>;
  handleCallback(destinationId: string, req: RawRequest): Promise<IngressOutcome>;
  runNow(
    processId: string,
    opts: Pick<RunNowRequest, 'dryRun' | 'batchId'>,
    meta: ChangeMeta,
  ): Promise<RunNowResponse>;
  approve(batchId: string, meta: ChangeMeta): Promise<ApproveResponse>;
  reject(batchId: string, meta: ChangeMeta): Promise<void>;
  replay(eventId: string, meta: ChangeMeta): Promise<EventIdsResponse>;
  injectTestEvent(
    sourceId: string,
    type: string | undefined,
    meta: ChangeMeta,
  ): Promise<EventIdsResponse>;
  closeRun(runId: string, status: SettledRunStatus, meta: ChangeMeta): Promise<void>;
  resetBreaker(processId: string, meta: ChangeMeta): Promise<void>;
  clearSoftHold(destinationId: string, meta: ChangeMeta): Promise<void>;
  readMetersNow(destinationId: string, meta: ChangeMeta): Promise<void>;
}

export interface PreviewPort {
  filterPreview(req: FilterPreviewRequest): Promise<FilterPreviewResponse>;
  inputPreview(req: InputPreviewRequest): Promise<InputPreviewResponse>;
  cronPreview(req: CronPreviewRequest): CronPreviewResponse;
  traceForArtifact(query: string): Promise<TraceResponse>;
  traceForEvent(eventId: string): Promise<TraceResponse>;
}
