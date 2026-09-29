/** Process nodes and cards show these for the last hour. */
export const PIPELINE_STOPS = ['matched', 'batched', 'gated', 'invoked', 'ok'] as const;

export const STAGE_STOPS = ['received', 'matched', 'batched', 'gated', 'invoked'] as const;
