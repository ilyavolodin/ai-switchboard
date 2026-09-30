/** Browser-safe (`@ai-switchboard/sdk/constants`): the canonical lists the SDK unions derive from. */
export const PLUGIN_KINDS = ['source', 'destination', 'notifier', 'secret_provider'] as const;
export const SOURCE_MODES = ['push', 'pull', 'both'] as const;
export const HEALTH_STATUSES = ['healthy', 'unhealthy', 'unknown'] as const;
export const TRACKING_MODES = ['sync', 'poll', 'callback', 'none'] as const;
export const INVOKE_STATUSES = ['started', 'completed', 'failed', 'held'] as const;
export const RUN_STATES = ['running', 'ok', 'error', 'unknown'] as const;
