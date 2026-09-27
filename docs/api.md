# REST API

All routes live under `/api/v1` unless noted. Request and response types are in
[`packages/core/src/api/contract.ts`](../packages/core/src/api/contract.ts) (`@ai-switchboard/core/contract`).

- Auth: a session cookie (`sb_session`) from sign-in, or `Authorization: Bearer <api token>`.
- Roles: `viewer` reads; `operator` also changes sources, executors, processes, approvals, manual runs and replays; `admin` also manages plugins, users, secret providers, notifiers and settings.
- Every state-changing body carries `reason` (non-empty). Every change writes `audit_log` rows.
- Errors: `{ error, message, details? }` with 400 (validation, including a malformed time or cursor), 401, 403, 404 (also for a malformed id in the path), 409 (version conflict, or a name already taken), 422 (semantic), 429 (too many sign-in attempts), 503.
- Lists: `?cursor=&limit=` → `Page<T>` (`{ items, nextCursor }`). Filters apply before paging, and a cursor is keyed by time and id, so rows that share a timestamp are neither skipped nor repeated.

## Unauthenticated surfaces

| Method | Path                     | Notes                                                                                                                |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| POST   | `/hooks/:sourceId`       | Push source ingress. Verified by the source's `verify`. Rejections return an empty 401. Disabled sources answer 200. |
| POST   | `/callbacks/:executorId` | Run callbacks. Verified by the executor's `verifyCallback`. Rejections return an empty 401.                          |
| GET    | `/healthz`               | Liveness.                                                                                                            |
| GET    | `/readyz`                | Postgres reachable and plugins loaded.                                                                               |
| GET    | `/metrics`               | Prometheus exposition (when enabled).                                                                                |

## Auth

| Method | Path                  | Body → Response                        | Role                            |
| ------ | --------------------- | -------------------------------------- | ------------------------------- |
| GET    | `/auth/me`            | → `MeResponse`                         | any (user null when signed out) |
| POST   | `/auth/login`         | `LocalLoginRequest` → `MeResponse`     | — (always, alongside OIDC)      |
| POST   | `/auth/password`      | `ChangePasswordRequest` → `MeResponse` | viewer (own, session only)      |
| GET    | `/auth/oidc/start`    | redirect to issuer                     | — (OIDC configured)             |
| GET    | `/auth/oidc/callback` | redirect to `/` (or `/no-access`)      | —                               |
| POST   | `/auth/logout`        | → 204                                  | any                             |
| GET    | `/auth/whoami`        | → `{ actor }` (the audit identity)     | viewer                          |

Local password sign-in works whether or not OIDC is configured; an account can have a password,
an OIDC identity, or both. `MeResponse.oidcIssuer` names the issuer for the "Sign in with …"
button.

**Temporary passwords.** A password an admin sets (on create or with `PUT /users/:id/password`),
and the generated bootstrap password, is temporary (`mustChangePassword`). A session that signed
in with it is restricted: every `/api` route except `GET /auth/me`, `POST /auth/password`,
`POST /auth/logout` (and the sign-in routes) answers 403 `{ error: 'password_change_required' }`
until the password changes, and `MeResponse.mustChangePassword` is true. An OIDC session or an API
token of the same user is not restricted.

**`POST /auth/password`** checks `currentPassword` (a wrong one is 400 `invalid_credentials`,
throttled like sign-in), applies the password rules (400 with the rule in `message`), stores the
new password, clears `mustChangePassword` and signs out the user's other sessions. It carries no
`reason`; the audit row reads "changed own password". An account without a password gets 409.

**Password rules:** at least 12 characters (at most 256), not the account's email (or the part
before `@`), not one of the most common passwords.

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

| Method | Path                                                                          | Body → Response                                       | Role     |
| ------ | ----------------------------------------------------------------------------- | ----------------------------------------------------- | -------- |
| GET    | `/events?source=&process=&executor=&stage=&type=&artifact=&from=&to=&cursor=` | → `Page<ActivityRow>`                                 | viewer   |
| GET    | `/events/:id`                                                                 | → `EventDetail`                                       | viewer   |
| POST   | `/events/:id/replay`                                                          | `Reasoned` → `{ eventIds }`                           | operator |
| GET    | `/trace?artifact=`                                                            | → `TraceResponse` (artifact id, `kind:id`, or `#482`) | viewer   |
| GET    | `/events/:id/trace`                                                           | → `TraceResponse`                                     | viewer   |

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

| Method | Path                       | Body → Response                                                                          | Role   |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| GET    | `/plugins`                 | → `PluginSummary[]`                                                                      | viewer |
| GET    | `/plugins/catalogue`       | → `CatalogueEntry[]`                                                                     | viewer |
| GET    | `/plugins/search?kind=&q=` | → `PluginSearchResponse`; 503 `registry_unavailable` when the registry cannot be reached | viewer |
| POST   | `/plugins/inspect`         | `InspectPluginRequest` → `InspectPluginResponse`                                         | admin  |
| POST   | `/plugins`                 | `InstallPluginRequest` → 201 `PluginSummary` (loaded at once; see below)                 | admin  |
| DELETE | `/plugins/:name`           | `Reasoned` → 204 (the loaded code is unloaded on the next restart)                       | admin  |

`GET /plugins/search` queries the npm registry (`SWITCHBOARD_NPM_REGISTRY`) for the union of the
name prefix (`ai-switchboard-{kind}`) and `keywords:switchboard-plugin`, and keeps only packages
that follow the naming convention — `ai-switchboard-{kind}-{name}`,
`@scope/ai-switchboard-{kind}-{name}` or `@ai-switchboard/{kind}-{name}` — where `kind` is
`source`, `executor`, `notifier` or `secrets` (the optional `kind` query parameter). Each result
carries the latest version, description, publisher, publish date, links, weekly downloads when the
registry reports them, `installed`/`installedVersion` on this replica, and `reviewed` (in the
catalogue).

`POST /plugins` installs the package into `$SWITCHBOARD_HOME/plugins`, pins it in
`plugins.lock.json`, records the spec and version in the `plugins` row and loads it into the
running process: its types are usable immediately. Every other replica installs and loads the
recorded plugin at boot and on a sync pass every `SWITCHBOARD_PLUGIN_SYNC_SECONDS` (60 s).
`pendingRestart: true` means another version of the plugin is already loaded (an upgrade); the new
version loads on the next restart. `DELETE /plugins/:name` uninstalls it here and removes the record
so replicas stop installing it.

## Notifiers and secret providers

`/notifiers` and `/secret-providers` share one shape: `GET` → `InstanceSummary[]`, `POST` `CreateInstanceRequest`, `PUT /:id` `UpdateInstanceRequest`, `POST /:id/enable` `EnableRequest`, `POST /:id/reload`, `DELETE /:id`, and for notifiers `POST /:id/test` (`Reasoned`). Role: admin for writes.

`GET /secret-providers/:id/secrets` → `ProviderSecretsResponse` (role: **admin**; secret names map
out the credentials a deployment holds, so viewers and operators get 403). It returns secret
**names only, never values**: each listed secret has its `secret://<provider>/<name>` `ref`, the
provider's optional `description` and `updatedAt`, and `usedBy` (every source, executor,
notifier, secret provider and process whose settings or document reference it, with the field
path). `missing` holds references to this provider whose names the provider does not list
(broken references). The core keeps only `name`, `description` and `updatedAt` from what the
plugin's `SecretProvider.list()` returns. A provider type without `list()`, a disabled or
stopped provider, or a failed or timed-out (10 s) listing gives `available: false` with an
`error`, and empty `secrets` and `missing`.

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
| PUT    | `/users/:id/password`                  | `SetPasswordRequest` → `UserDTO` (temporary)       | admin (not own)      |
| DELETE | `/users/:id/password`                  | `Reasoned` → `UserDTO` (OIDC-only from now on)     | admin (OIDC on)      |
| GET    | `/tokens`                              | → `ApiTokenDTO[]` (own)                            | viewer               |
| POST   | `/tokens`                              | `CreateApiTokenRequest` → `CreateApiTokenResponse` | viewer (role ≤ own)  |
| DELETE | `/tokens/:id`                          | `Reasoned` → 204                                   | viewer (own) / admin |
| GET    | `/audit?scope=&target=&actor=&cursor=` | → `Page<AuditEntry>`                               | viewer               |
| GET    | `/export`                              | → YAML (`text/yaml`)                               | operator             |
| POST   | `/apply`                               | `ApplyRequest` → `ApplyResponse`                   | admin                |
| GET    | `/about`                               | → `AboutResponse`                                  | viewer               |

`POST /users` takes an optional `password`: the user signs in with it once and must change it.
`PUT /users/:id/password` sets or resets a temporary password (the rules above apply), marks the
account `mustChangePassword` and signs the user out everywhere; an admin changes their own
password with `POST /auth/password` instead (409 here). `DELETE /users/:id/password` removes the
password and signs the user out; it is refused (409) while OIDC is not configured, since the
account could no longer sign in. The audit rows record `password` / `password_reset` with
`temporary`, `set` or `removed`, never the value.
