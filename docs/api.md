# REST API

All routes live under `/api/v1` unless noted. Request and response types are in
[`packages/core/src/api/contract.ts`](../packages/core/src/api/contract.ts) (`@ai-switchboard/core/contract`).

- Auth: a session cookie (`sb_session`) from sign-in, or `Authorization: Bearer <api token>`.
- Roles: `viewer` reads; `operator` also changes sources, executors, processes, approvals, manual runs and replays; `admin` also manages plugins, users, secret providers, notifiers and settings.
- Every state-changing body carries `reason` (non-empty). Every change writes `audit_log` rows.
- Errors: `{ error, message, details? }` with 400 (validation), 401, 403, 404, 409 (version conflict), 422 (semantic), 503.
- Lists: `?cursor=&limit=` → `Page<T>` (`{ items, nextCursor }`).

## Unauthenticated surfaces

| Method | Path                     | Notes                                                                                                                |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| POST   | `/hooks/:sourceId`       | Push source ingress. Verified by the source's `verify`. Rejections return an empty 401. Disabled sources answer 200. |
| POST   | `/callbacks/:executorId` | Run callbacks. Verified by the executor's `verifyCallback`. Rejections return an empty 401.                          |
| GET    | `/healthz`               | Liveness.                                                                                                            |
| GET    | `/readyz`                | Postgres reachable and plugins loaded.                                                                               |
| GET    | `/metrics`               | Prometheus exposition (when enabled).                                                                                |

## Auth

| Method | Path                  | Body → Response                    | Role                            |
| ------ | --------------------- | ---------------------------------- | ------------------------------- |
| GET    | `/auth/me`            | → `MeResponse`                     | any (user null when signed out) |
| POST   | `/auth/login`         | `LocalLoginRequest` → `MeResponse` | — (local mode only)             |
| GET    | `/auth/oidc/start`    | redirect to issuer                 | —                               |
| GET    | `/auth/oidc/callback` | redirect to `/` (or `/no-access`)  | —                               |
| POST   | `/auth/logout`        | → 204                              | any                             |
| GET    | `/auth/whoami`        | → `{ actor }` (the audit identity) | viewer                          |

## Board and status

| Method | Path      | Response              | Role   |
| ------ | --------- | --------------------- | ------ |
| GET    | `/status` | `StatusStripResponse` | viewer |
| GET    | `/board`  | `BoardResponse`       | viewer |

## Plugin types

| Method | Path                  | Response          | Role   |
| ------ | --------------------- | ----------------- | ------ |
| GET    | `/plugin-types?kind=` | `PluginTypeDTO[]` | viewer |

## Sources

| Method | Path                                | Body → Response                         | Role     |
| ------ | ----------------------------------- | --------------------------------------- | -------- |
| GET    | `/sources`                          | → `SourceSummary[]`                     | viewer   |
| POST   | `/sources`                          | `CreateSourceRequest` → `SourceDetail`  | operator |
| GET    | `/sources/:id`                      | → `SourceDetail`                        | viewer   |
| PUT    | `/sources/:id`                      | `UpdateSourceRequest` → `SourceDetail`  | operator |
| DELETE | `/sources/:id`                      | `Reasoned` → 204                        | operator |
| POST   | `/sources/:id/enable`               | `EnableRequest` → `SourceDetail`        | operator |
| POST   | `/sources/:id/provision`            | `Reasoned` → `{ ok, message }`          | operator |
| POST   | `/sources/:id/test-event`           | `Reasoned & { type? }` → `{ eventIds }` | operator |
| POST   | `/sources/:id/reload`               | `Reasoned` → `SourceDetail`             | operator |
| GET    | `/sources/:id/stats?window=`        | → `SourceStatsResponse`                 | viewer   |
| GET    | `/sources/:id/events?cursor=&type=` | → `Page<ActivityRow>`                   | viewer   |

## Executors

| Method | Path                             | Body → Response                            | Role     |
| ------ | -------------------------------- | ------------------------------------------ | -------- |
| GET    | `/executors`                     | → `ExecutorSummary[]`                      | viewer   |
| POST   | `/executors`                     | `CreateExecutorRequest` → `ExecutorDetail` | operator |
| GET    | `/executors/:id`                 | → `ExecutorDetail`                         | viewer   |
| PUT    | `/executors/:id`                 | `UpdateExecutorRequest` → `ExecutorDetail` | operator |
| DELETE | `/executors/:id`                 | `Reasoned` → 204                           | operator |
| POST   | `/executors/:id/enable`          | `EnableRequest` → `ExecutorDetail`         | operator |
| POST   | `/executors/:id/reload`          | `Reasoned` → `ExecutorDetail`              | operator |
| POST   | `/executors/:id/meters/read`     | `Reasoned` → `MeterGaugeDTO[]`             | operator |
| POST   | `/executors/:id/soft-hold/clear` | `Reasoned` → `ExecutorDetail`              | operator |
| GET    | `/executors/:id/meters?window=`  | → `MeterHistoryResponse`                   | viewer   |
| GET    | `/executors/:id/usage?window=`   | → `UsageHistoryResponse`                   | viewer   |

## Processes

| Method | Path                                       | Body → Response                                                    | Role     |
| ------ | ------------------------------------------ | ------------------------------------------------------------------ | -------- |
| GET    | `/processes`                               | → `ProcessSummary[]`                                               | viewer   |
| POST   | `/processes`                               | `CreateProcessRequest` → `ProcessDetail`                           | operator |
| GET    | `/processes/:id`                           | → `ProcessDetail`                                                  | viewer   |
| PUT    | `/processes/:id`                           | `UpdateProcessRequest` → `ProcessDetail` (409 on version conflict) | operator |
| DELETE | `/processes/:id`                           | `Reasoned` → 204                                                   | operator |
| POST   | `/processes/:id/enable`                    | `EnableRequest` → `ProcessDetail`                                  | operator |
| POST   | `/processes/:id/run`                       | `RunNowRequest` → `{ batchId, runId \| null, outcome }`            | operator |
| POST   | `/processes/:id/breaker/reset`             | `Reasoned` → `ProcessDetail`                                       | operator |
| GET    | `/processes/:id/funnel?window=`            | → `FunnelResponse`                                                 | viewer   |
| GET    | `/processes/:id/stats?window=`             | → `ProcessStatsResponse`                                           | viewer   |
| GET    | `/processes/:id/versions`                  | → `ProcessVersionSummary[]`                                        | viewer   |
| GET    | `/processes/:id/versions/:version`         | → `ProcessVersionDetail`                                           | viewer   |
| POST   | `/processes/:id/versions/:version/restore` | `Reasoned` → `ProcessDetail`                                       | operator |
| GET    | `/processes/:id/batches?limit=`            | → `RecentBatchDTO[]`                                               | viewer   |
| GET    | `/processes/:id/activity?cursor=`          | → `Page<ActivityRow>`                                              | viewer   |
| POST   | `/processes/preview/filter`                | `FilterPreviewRequest` → `FilterPreviewResponse`                   | viewer   |
| POST   | `/processes/preview/input`                 | `InputPreviewRequest` → `InputPreviewResponse`                     | viewer   |
| POST   | `/processes/preview/cron`                  | `CronPreviewRequest` → `CronPreviewResponse`                       | viewer   |

## Activity, events, trace

| Method | Path                                                                    | Body → Response                                       | Role     |
| ------ | ----------------------------------------------------------------------- | ----------------------------------------------------- | -------- |
| GET    | `/events?source=&process=&executor=&stage=&artifact=&from=&to=&cursor=` | → `Page<ActivityRow>`                                 | viewer   |
| GET    | `/events/:id`                                                           | → `EventDetail`                                       | viewer   |
| POST   | `/events/:id/replay`                                                    | `Reasoned` → `{ eventIds }`                           | operator |
| GET    | `/trace?artifact=`                                                      | → `TraceResponse` (artifact id, `kind:id`, or `#482`) | viewer   |
| GET    | `/events/:id/trace`                                                     | → `TraceResponse`                                     | viewer   |

## Runs

| Method | Path                                       | Body → Response                 | Role     |
| ------ | ------------------------------------------ | ------------------------------- | -------- |
| GET    | `/runs?process=&executor=&status=&cursor=` | → `Page<RunSummary>`            | viewer   |
| GET    | `/runs/:id`                                | → `RunDetail`                   | viewer   |
| POST   | `/runs/:id/close`                          | `CloseRunRequest` → `RunDetail` | operator |

## Approvals

| Method | Path                          | Body → Response                           | Role     |
| ------ | ----------------------------- | ----------------------------------------- | -------- |
| GET    | `/approvals`                  | → `ApprovalItem[]`                        | viewer   |
| GET    | `/approvals/history?cursor=`  | → `Page<ApprovalHistoryItem>`             | viewer   |
| GET    | `/approvals/rules`            | → `ApprovalRulesResponse`                 | viewer   |
| POST   | `/approvals/:batchId/approve` | `Reasoned` → `{ runId \| null, outcome }` | operator |
| POST   | `/approvals/:batchId/reject`  | `Reasoned` → 204                          | operator |

## Plugins

| Method | Path                 | Body → Response                                               | Role   |
| ------ | -------------------- | ------------------------------------------------------------- | ------ |
| GET    | `/plugins`           | → `PluginSummary[]`                                           | viewer |
| GET    | `/plugins/catalogue` | → `CatalogueEntry[]`                                          | viewer |
| POST   | `/plugins/inspect`   | `InspectPluginRequest` → `InspectPluginResponse`              | admin  |
| POST   | `/plugins`           | `InstallPluginRequest` → `PluginSummary` (applies on restart) | admin  |
| DELETE | `/plugins/:name`     | `Reasoned` → 204 (applies on restart)                         | admin  |

## Notifiers and secret providers

`/notifiers` and `/secret-providers` share one shape: `GET` → `InstanceSummary[]`, `POST` `CreateInstanceRequest`, `PUT /:id` `UpdateInstanceRequest`, `POST /:id/enable` `EnableRequest`, `POST /:id/reload`, `DELETE /:id`, and for notifiers `POST /:id/test` (`Reasoned`). Role: admin for writes.

## Settings, users, tokens, audit, export

| Method | Path                                   | Body → Response                                    | Role                 |
| ------ | -------------------------------------- | -------------------------------------------------- | -------------------- |
| GET    | `/settings`                            | → `GlobalSettings`                                 | viewer               |
| PUT    | `/settings`                            | `UpdateSettingsRequest` → `GlobalSettings`         | admin                |
| GET    | `/users`                               | → `UserDTO[]`                                      | admin                |
| POST   | `/users`                               | `CreateUserRequest` → `UserDTO`                    | admin                |
| PUT    | `/users/:id`                           | `UpdateUserRequest` → `UserDTO`                    | admin                |
| DELETE | `/users/:id`                           | `Reasoned` → 204                                   | admin                |
| POST   | `/users/:id/sessions/revoke`           | `Reasoned` → 204 (signs the user out everywhere)   | admin                |
| GET    | `/tokens`                              | → `ApiTokenDTO[]` (own)                            | viewer               |
| POST   | `/tokens`                              | `CreateApiTokenRequest` → `CreateApiTokenResponse` | viewer (role ≤ own)  |
| DELETE | `/tokens/:id`                          | `Reasoned` → 204                                   | viewer (own) / admin |
| GET    | `/audit?scope=&target=&actor=&cursor=` | → `Page<AuditEntry>`                               | viewer               |
| GET    | `/export`                              | → YAML (`text/yaml`)                               | operator             |
| POST   | `/apply`                               | `ApplyRequest` → `ApplyResponse`                   | admin                |
| GET    | `/about`                               | → `AboutResponse`                                  | viewer               |
