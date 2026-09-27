/** The five pipeline dots on process nodes and cards (the last hour). */
export const PIPELINE_STOPS = ['matched', 'batched', 'gated', 'invoked', 'ok'] as const;

/** The five stops of an event's stage indicator. */
export const STAGE_STOPS = ['received', 'matched', 'batched', 'gated', 'invoked'] as const;
