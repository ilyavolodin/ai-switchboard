import type { RawRequest } from '@ai-switchboard/sdk';

import type {
  CronPreviewRequest,
  CronPreviewResponse,
  FilterPreviewRequest,
  FilterPreviewResponse,
  InputPreviewRequest,
  InputPreviewResponse,
  TraceResponse,
} from './contract.js';

/**
 * What the API needs from the pipeline services (`services/pipeline`). Declared here so the HTTP
 * layer depends on a port, not on the pipeline's internals.
 */
export interface PipelinePort {
  ingestPush(sourceId: string, req: RawRequest): Promise<{ status: number }>;
  handleCallback(executorId: string, req: RawRequest): Promise<{ status: number }>;
  runNow(
    processId: string,
    opts: { dryRun?: boolean; batchId?: string; actor: string; reason: string },
  ): Promise<{ batchId: string; runId: string | null; outcome: string }>;
  approve(
    batchId: string,
    actor: string,
    reason: string,
  ): Promise<{ runId: string | null; outcome: string }>;
  reject(batchId: string, actor: string, reason: string): Promise<void>;
  replay(eventId: string, actor: string, reason: string): Promise<{ eventIds: string[] }>;
  injectTestEvent(
    sourceId: string,
    type: string | undefined,
    actor: string,
    reason: string,
  ): Promise<{ eventIds: string[] }>;
  closeRun(
    runId: string,
    status: 'ok' | 'error' | 'unknown',
    actor: string,
    reason: string,
  ): Promise<void>;
  resetBreaker(processId: string, actor: string, reason: string): Promise<void>;
  clearSoftHold(executorId: string, actor: string, reason: string): Promise<void>;
  readMetersNow(executorId: string): Promise<void>;
}

export interface PreviewPort {
  filterPreview(req: FilterPreviewRequest): Promise<FilterPreviewResponse>;
  inputPreview(req: InputPreviewRequest): Promise<InputPreviewResponse>;
  cronPreview(req: CronPreviewRequest): CronPreviewResponse;
  traceForArtifact(query: string): Promise<TraceResponse>;
  traceForEvent(eventId: string): Promise<TraceResponse>;
}
