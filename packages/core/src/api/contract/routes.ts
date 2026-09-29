import type { GlobalSettings } from '../../domain/settings.js';
import type {
  AboutResponse,
  ApplyRequest,
  ApplyResponse,
  AuditEntry,
  AuditQuery,
  UpdateSettingsRequest,
} from './admin.js';
import type {
  ApprovalHistoryItem,
  ApprovalHistoryQuery,
  ApprovalItem,
  ApprovalRulesResponse,
  ApproveResponse,
} from './approvals.js';
import type {
  ApiTokenDTO,
  ChangePasswordRequest,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  CreateUserRequest,
  LocalLoginRequest,
  MeResponse,
  SetPasswordRequest,
  UpdateUserRequest,
  UserDirectoryEntry,
  UserDTO,
  WhoAmIResponse,
} from './auth.js';
import type { BoardResponse, StatusStripResponse } from './board.js';
import type { EnableRequest, Page, Reasoned, ResultResponse, WindowQuery } from './common.js';
import type {
  CreateDestinationRequest,
  DestinationDetail,
  DestinationSummary,
  MeterGaugeDTO,
  MeterHistoryResponse,
  UpdateDestinationRequest,
  UsageHistoryResponse,
} from './destinations.js';
import type {
  ActivityQuery,
  ActivityRow,
  EventDetail,
  TraceQuery,
  TraceResponse,
} from './events.js';
import type {
  CreateInstanceRequest,
  InstanceSummary,
  ProviderSecretsResponse,
  UpdateInstanceRequest,
} from './instances.js';
import type {
  CatalogueEntry,
  InspectPluginRequest,
  InspectPluginResponse,
  InstallPluginRequest,
  PluginSearchQuery,
  PluginSearchResponse,
  PluginSummary,
  PluginTypeDTO,
  PluginTypesQuery,
} from './plugins.js';
import type {
  CreateProcessRequest,
  CronPreviewRequest,
  CronPreviewResponse,
  FilterPreviewRequest,
  FilterPreviewResponse,
  FunnelResponse,
  InputPreviewRequest,
  InputPreviewResponse,
  LimitQuery,
  ProcessDetail,
  ProcessStatsResponse,
  ProcessSummary,
  ProcessVersionDetail,
  ProcessVersionSummary,
  RecentBatchDTO,
  RunNowRequest,
  RunNowResponse,
  UpdateProcessRequest,
} from './processes.js';
import type { CloseRunRequest, RunDetail, RunsQuery, RunSummary } from './runs.js';
import type {
  CreateSourceRequest,
  EventIdsResponse,
  LastDeliveryResponse,
  SourceDetail,
  SourcePreviewRequest,
  SourcePreviewResponse,
  SourceStatsResponse,
  SourceSummary,
  TestEventRequest,
  UpdateSourceRequest,
} from './sources.js';

/** An empty body: a 204, or a redirect. */
export type NoContent = undefined;

export interface RouteShape {
  body?: unknown;
  query?: unknown;
  res: unknown;
}

/**
 * Every `/api/v1` route as `'METHOD /path'` → its body, query string and response. A core test
 * checks this list against the routes the server registers.
 */
export interface ApiRoutes {
  'GET /api/v1/auth/me': { res: MeResponse };
  'POST /api/v1/auth/login': { body: LocalLoginRequest; res: MeResponse };
  'POST /api/v1/auth/password': { body: ChangePasswordRequest; res: MeResponse };
  'POST /api/v1/auth/logout': { res: NoContent };
  'GET /api/v1/auth/oidc/start': { res: NoContent };
  'GET /api/v1/auth/oidc/callback': { res: NoContent };
  'GET /api/v1/auth/whoami': { res: WhoAmIResponse };

  'GET /api/v1/status': { res: StatusStripResponse };
  'GET /api/v1/board': { res: BoardResponse };

  'GET /api/v1/sources': { res: SourceSummary[] };
  'POST /api/v1/sources': { body: CreateSourceRequest; res: SourceDetail };
  'POST /api/v1/sources/preview': { body: SourcePreviewRequest; res: SourcePreviewResponse };
  'GET /api/v1/sources/:id': { res: SourceDetail };
  'PUT /api/v1/sources/:id': { body: UpdateSourceRequest; res: SourceDetail };
  'DELETE /api/v1/sources/:id': { body: Reasoned; res: NoContent };
  'POST /api/v1/sources/:id/enable': { body: EnableRequest; res: SourceDetail };
  'POST /api/v1/sources/:id/reload': { body: Reasoned; res: SourceDetail };
  'POST /api/v1/sources/:id/provision': { body: Reasoned; res: ResultResponse };
  'POST /api/v1/sources/:id/test-event': { body: TestEventRequest; res: EventIdsResponse };
  'GET /api/v1/sources/:id/stats': { query: WindowQuery; res: SourceStatsResponse };
  'GET /api/v1/sources/:id/events': { query: ActivityQuery; res: Page<ActivityRow> };
  'GET /api/v1/sources/:id/last-delivery': { res: LastDeliveryResponse };

  'GET /api/v1/destinations': { res: DestinationSummary[] };
  'POST /api/v1/destinations': { body: CreateDestinationRequest; res: DestinationDetail };
  'GET /api/v1/destinations/:id': { res: DestinationDetail };
  'PUT /api/v1/destinations/:id': { body: UpdateDestinationRequest; res: DestinationDetail };
  'DELETE /api/v1/destinations/:id': { body: Reasoned; res: NoContent };
  'POST /api/v1/destinations/:id/enable': { body: EnableRequest; res: DestinationDetail };
  'POST /api/v1/destinations/:id/reload': { body: Reasoned; res: DestinationDetail };
  'POST /api/v1/destinations/:id/meters/read': { body: Reasoned; res: MeterGaugeDTO[] };
  'POST /api/v1/destinations/:id/soft-hold/clear': { body: Reasoned; res: DestinationDetail };
  'GET /api/v1/destinations/:id/meters': { query: WindowQuery; res: MeterHistoryResponse };
  'GET /api/v1/destinations/:id/usage': { query: WindowQuery; res: UsageHistoryResponse };

  'GET /api/v1/notifiers': { res: InstanceSummary[] };
  'POST /api/v1/notifiers': { body: CreateInstanceRequest; res: InstanceSummary };
  'PUT /api/v1/notifiers/:id': { body: UpdateInstanceRequest; res: InstanceSummary };
  'DELETE /api/v1/notifiers/:id': { body: Reasoned; res: NoContent };
  'POST /api/v1/notifiers/:id/enable': { body: EnableRequest; res: InstanceSummary };
  'POST /api/v1/notifiers/:id/reload': { body: Reasoned; res: InstanceSummary };
  'POST /api/v1/notifiers/:id/test': { body: Reasoned; res: ResultResponse };

  'GET /api/v1/secret-providers': { res: InstanceSummary[] };
  'POST /api/v1/secret-providers': { body: CreateInstanceRequest; res: InstanceSummary };
  'PUT /api/v1/secret-providers/:id': { body: UpdateInstanceRequest; res: InstanceSummary };
  'DELETE /api/v1/secret-providers/:id': { body: Reasoned; res: NoContent };
  'POST /api/v1/secret-providers/:id/enable': { body: EnableRequest; res: InstanceSummary };
  'POST /api/v1/secret-providers/:id/reload': { body: Reasoned; res: InstanceSummary };
  'GET /api/v1/secret-providers/:id/secrets': { res: ProviderSecretsResponse };

  'GET /api/v1/processes': { res: ProcessSummary[] };
  'POST /api/v1/processes': { body: CreateProcessRequest; res: ProcessDetail };
  'GET /api/v1/processes/:id': { res: ProcessDetail };
  'PUT /api/v1/processes/:id': { body: UpdateProcessRequest; res: ProcessDetail };
  'DELETE /api/v1/processes/:id': { body: Reasoned; res: NoContent };
  'POST /api/v1/processes/:id/enable': { body: EnableRequest; res: ProcessDetail };
  'POST /api/v1/processes/:id/run': { body: RunNowRequest; res: RunNowResponse };
  'POST /api/v1/processes/:id/breaker/reset': { body: Reasoned; res: ProcessDetail };
  'GET /api/v1/processes/:id/versions': { res: ProcessVersionSummary[] };
  'GET /api/v1/processes/:id/versions/:version': { res: ProcessVersionDetail };
  'POST /api/v1/processes/:id/versions/:version/restore': { body: Reasoned; res: ProcessDetail };
  'GET /api/v1/processes/:id/batches': { query: LimitQuery; res: RecentBatchDTO[] };
  'GET /api/v1/processes/:id/funnel': { query: WindowQuery; res: FunnelResponse };
  'GET /api/v1/processes/:id/stats': { query: WindowQuery; res: ProcessStatsResponse };
  'GET /api/v1/processes/:id/activity': { query: ActivityQuery; res: Page<ActivityRow> };
  'POST /api/v1/processes/preview/filter': {
    body: FilterPreviewRequest;
    res: FilterPreviewResponse;
  };
  'POST /api/v1/processes/preview/input': { body: InputPreviewRequest; res: InputPreviewResponse };
  'POST /api/v1/processes/preview/cron': { body: CronPreviewRequest; res: CronPreviewResponse };

  'GET /api/v1/events': { query: ActivityQuery; res: Page<ActivityRow> };
  'GET /api/v1/events/:id': { res: EventDetail };
  'POST /api/v1/events/:id/replay': { body: Reasoned; res: EventIdsResponse };
  'GET /api/v1/events/:id/trace': { res: TraceResponse };
  'GET /api/v1/trace': { query: TraceQuery; res: TraceResponse };

  'GET /api/v1/runs': { query: RunsQuery; res: Page<RunSummary> };
  'GET /api/v1/runs/:id': { res: RunDetail };
  'POST /api/v1/runs/:id/close': { body: CloseRunRequest; res: RunDetail };

  'GET /api/v1/approvals': { res: ApprovalItem[] };
  'GET /api/v1/approvals/history': { query: ApprovalHistoryQuery; res: Page<ApprovalHistoryItem> };
  'GET /api/v1/approvals/rules': { res: ApprovalRulesResponse };
  'POST /api/v1/approvals/:batchId/approve': { body: Reasoned; res: ApproveResponse };
  'POST /api/v1/approvals/:batchId/reject': { body: Reasoned; res: NoContent };

  'GET /api/v1/plugin-types': { query: PluginTypesQuery; res: PluginTypeDTO[] };
  'GET /api/v1/plugins': { res: PluginSummary[] };
  'POST /api/v1/plugins': { body: InstallPluginRequest; res: PluginSummary };
  'DELETE /api/v1/plugins/:name': { body: Reasoned; res: NoContent };
  'GET /api/v1/plugins/search': { query: PluginSearchQuery; res: PluginSearchResponse };
  'GET /api/v1/plugins/catalogue': { res: CatalogueEntry[] };
  'POST /api/v1/plugins/inspect': { body: InspectPluginRequest; res: InspectPluginResponse };

  'GET /api/v1/users': { res: UserDTO[] };
  'POST /api/v1/users': { body: CreateUserRequest; res: UserDTO };
  'GET /api/v1/users/directory': { res: UserDirectoryEntry[] };
  'PUT /api/v1/users/:id': { body: UpdateUserRequest; res: UserDTO };
  'DELETE /api/v1/users/:id': { body: Reasoned; res: NoContent };
  'PUT /api/v1/users/:id/password': { body: SetPasswordRequest; res: UserDTO };
  'DELETE /api/v1/users/:id/password': { body: Reasoned; res: UserDTO };
  'POST /api/v1/users/:id/sessions/revoke': { body: Reasoned; res: NoContent };
  'GET /api/v1/tokens': { res: ApiTokenDTO[] };
  'POST /api/v1/tokens': { body: CreateApiTokenRequest; res: CreateApiTokenResponse };
  'DELETE /api/v1/tokens/:id': { body: Reasoned; res: NoContent };

  'GET /api/v1/settings': { res: GlobalSettings };
  'PUT /api/v1/settings': { body: UpdateSettingsRequest; res: GlobalSettings };
  'GET /api/v1/audit': { query: AuditQuery; res: Page<AuditEntry> };
  'GET /api/v1/about': { res: AboutResponse };

  /** YAML text (`text/yaml`). */
  'GET /api/v1/export': { res: string };
  'POST /api/v1/apply': { body: ApplyRequest; res: ApplyResponse };
}

export type ApiRoute = keyof ApiRoutes;
