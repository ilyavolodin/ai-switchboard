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
} from './contract.js';

/** Declared here so the HTTP layer depends on a port, not on the pipeline's internals. */
export interface PipelinePort {
  ingestPush(sourceId: string, req: RawRequest): Promise<{ status: number }>;
  handleCallback(destinationId: string, req: RawRequest): Promise<{ status: number }>;
  runNow(
    processId: string,
    opts: Pick<RunNowRequest, 'dryRun' | 'batchId'> & { actor: string; reason: string },
  ): Promise<RunNowResponse>;
  approve(batchId: string, actor: string, reason: string): Promise<ApproveResponse>;
  reject(batchId: string, actor: string, reason: string): Promise<void>;
  replay(eventId: string, actor: string, reason: string): Promise<EventIdsResponse>;
  injectTestEvent(
    sourceId: string,
    type: string | undefined,
    actor: string,
    reason: string,
  ): Promise<EventIdsResponse>;
  closeRun(runId: string, status: SettledRunStatus, actor: string, reason: string): Promise<void>;
  resetBreaker(processId: string, actor: string, reason: string): Promise<void>;
  clearSoftHold(destinationId: string, actor: string, reason: string): Promise<void>;
  readMetersNow(destinationId: string): Promise<void>;
}

export interface PreviewPort {
  filterPreview(req: FilterPreviewRequest): Promise<FilterPreviewResponse>;
  inputPreview(req: InputPreviewRequest): Promise<InputPreviewResponse>;
  cronPreview(req: CronPreviewRequest): CronPreviewResponse;
  traceForArtifact(query: string): Promise<TraceResponse>;
  traceForEvent(eventId: string): Promise<TraceResponse>;
}
