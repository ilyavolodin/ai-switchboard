import type { DecisionStage, MatchSkip } from './status.js';

/**
 * One trigger filter evaluated for an event (`events.match_decisions`). A trigger on the event's
 * source that was never evaluated is recorded too, with `skip` naming why and `result: false`.
 */
export interface MatchDecisionRecord {
  processId: string;
  triggerId: string;
  expr?: string;
  result: boolean;
  error?: string;
  /** Set when the trigger was not evaluated at all; absent on events matched before it existed. */
  skip?: MatchSkip;
  /** The batch key the group-by expression produced (when it matched). */
  batchKey?: string;
  at: string;
}

/** A gate or budget check at decision time (`batches.decisions`), for the trace. */
export interface GateDecisionRecord {
  /** `batch` records open/close, `approval` the decision, `gate`/`budget` the checks. */
  stage: DecisionStage;
  check: string;
  pass: boolean;
  detail?: string;
  at: string;
  /** Budget stage: counters and meter readings at that moment. */
  data?: Record<string, unknown>;
}
