import type {
  ActivityQuery,
  AuditQuery,
  CronPreviewRequest,
  FilterPreviewRequest,
  InputPreviewRequest,
  PluginKind,
  RunsQuery,
  SourcePreviewRequest,
  StatsWindow,
} from '@ai-switchboard/core/contract';

/** The first element is the area, so invalidating `['sources']` refreshes every sources query. */
export const qk = {
  me: ['me'] as const,
  whoami: ['me', 'whoami'] as const,
  status: ['status'] as const,
  board: ['board'] as const,
  /** Installing a plugin invalidates this prefix to refresh every `pluginTypes(kind)`. */
  pluginTypesAll: ['plugin-types'] as const,
  pluginTypes: (kind?: PluginKind) => ['plugin-types', kind ?? 'all'] as const,

  sources: {
    all: ['sources'] as const,
    list: () => ['sources', 'list'] as const,
    detail: (id: string) => ['sources', 'detail', id] as const,
    stats: (id: string, window: StatsWindow) => ['sources', 'stats', id, window] as const,
    events: (id: string, type?: string) => ['sources', 'events', id, type ?? ''] as const,
    lastDelivery: (id: string) => ['sources', 'last-delivery', id] as const,
  },

  destinations: {
    all: ['destinations'] as const,
    list: () => ['destinations', 'list'] as const,
    detail: (id: string) => ['destinations', 'detail', id] as const,
    meters: (id: string, window: StatsWindow) => ['destinations', 'meters', id, window] as const,
    usage: (id: string, window: StatsWindow) => ['destinations', 'usage', id, window] as const,
  },

  processes: {
    all: ['processes'] as const,
    list: () => ['processes', 'list'] as const,
    detail: (id: string) => ['processes', 'detail', id] as const,
    funnel: (id: string, window: StatsWindow) => ['processes', 'funnel', id, window] as const,
    stats: (id: string, window: StatsWindow) => ['processes', 'stats', id, window] as const,
    versions: (id: string) => ['processes', 'versions', id] as const,
    version: (id: string, version: number) => ['processes', 'version', id, version] as const,
    batches: (id: string, limit?: number) => ['processes', 'batches', id, limit ?? 20] as const,
    activity: (id: string) => ['processes', 'activity', id] as const,
  },

  preview: {
    filter: (req: FilterPreviewRequest) => ['preview', 'filter', req] as const,
    input: (req: InputPreviewRequest) => ['preview', 'input', req] as const,
    cron: (req: CronPreviewRequest) => ['preview', 'cron', req] as const,
    source: (req: SourcePreviewRequest) => ['preview', 'source', req] as const,
  },

  events: {
    all: ['events'] as const,
    list: (q: ActivityQuery) => ['events', 'list', q] as const,
    detail: (id: string) => ['events', 'detail', id] as const,
    trace: (id: string) => ['events', 'trace', id] as const,
  },
  trace: (artifact: string) => ['trace', artifact] as const,

  runs: {
    all: ['runs'] as const,
    list: (q: RunsQuery) => ['runs', 'list', q] as const,
    detail: (id: string) => ['runs', 'detail', id] as const,
  },

  approvals: {
    all: ['approvals'] as const,
    pending: () => ['approvals', 'pending'] as const,
    history: () => ['approvals', 'history'] as const,
    rules: () => ['approvals', 'rules'] as const,
  },

  plugins: {
    all: ['plugins'] as const,
    installed: () => ['plugins', 'installed'] as const,
    catalogue: () => ['plugins', 'catalogue'] as const,
    search: (kind: string, q: string) => ['plugins', 'search', kind, q] as const,
  },

  instances: (kind: 'notifiers' | 'secret-providers') => [kind] as const,
  /** Under the secret-providers key, so `instances('secret-providers')` invalidates it. */
  providerSecrets: (id: string) => ['secret-providers', 'secrets', id] as const,

  settings: ['settings'] as const,
  users: ['users'] as const,
  tokens: ['tokens'] as const,
  audit: (q: AuditQuery) => ['audit', q] as const,
  about: ['about'] as const,
};

/** Polling intervals, in ms. */
export const POLL = {
  live: 10_000,
  lists: 30_000,
  activity: 15_000,
} as const;
