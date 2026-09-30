# REST API

All routes live under `/api/v1` unless noted. Request and response types are in
[`packages/core/src/contract/index.ts`](../packages/core/src/contract/index.ts)
(`@ai-switchboard/core/contract`), a barrel over one file per resource in `contract/`. It is
layer-neutral: routes, services and the UI import it. `ApiRoutes` maps every route
(`'POST /api/v1/sources'`) to its body, query and response types; a core test fails when it and
the registered routes differ. Each request body's JSON Schema sits next to its type
(`createSourceBody` next to `CreateSourceRequest`) and is checked against it at compile time.

- Auth: a session cookie (`sb_session`) from sign-in, or `Authorization: Bearer <api token>`.
- Roles: `viewer` reads; `operator` also changes sources, destinations, processes, approvals, manual runs and replays; `admin` also manages plugins, users, secret providers, notifiers and settings.
- Every state-changing body carries `reason` (non-empty). Every change writes `audit_log` rows. An admin can make reasons optional (`GlobalSettings.requireReasons: false`, Settings › General): then a missing or blank `reason` is accepted (a `DELETE` may omit the body) and audited as `(no reason given)`. `MeResponse.requireReasons` tells a client whether to ask. Each replica caches the setting for 5 s; the replica that saves it applies it at once, the others within the cache window.
- Errors: `{ error, message, details?, usedBy? }` with 400 (validation: a body that does not match its schema answers `The request did not validate.` with one `details` line per problem; also a malformed time, or a cursor this API did not issue), 401, 403, 404 (also for a malformed id in the path), 409 (version conflict, a name already taken, or deleting a source, destination or notifier that processes still use: `usedBy` lists them as `{ id, name }`), 422 (semantic), 429 (too many sign-in attempts), 503.
- Lists: `?cursor=&limit=` → `Page<T>` (`{ items, nextCursor }`). Filters apply before paging, and a cursor is keyed by time and id, so rows that share a timestamp are neither skipped nor repeated. A cursor that is not one this API returned is a 400, not a restart at the first page.

## Unauthenticated surfaces

| Method | Path                        | Notes                                                                                                                |
| ------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| POST   | `/hooks/:sourceId`          | Push source ingress. Verified by the source's `verify`. Rejections return an empty 401. Disabled sources answer 200. |
| POST   | `/callbacks/:destinationId` | Run callbacks. Verified by the destination's `verifyCallback`. Rejections return an empty 401.                       |
| GET    | `/healthz`                  | Liveness.                                                                                                            |
| GET    | `/readyz`                   | Postgres reachable and plugins loaded.                                                                               |
| GET    | `/metrics`                  | Prometheus exposition (when enabled).                                                                                |

## Auth

| Method | Path                  | Body → Response                         | Role                            |
| ------ | --------------------- | --------------------------------------- | ------------------------------- |
| GET    | `/auth/me`            | → `MeResponse`                          | any (user null when signed out) |
| POST   | `/auth/login`         | `LocalLoginRequest` → `MeResponse`      | — (always, alongside OIDC)      |
| POST   | `/auth/password`      | `ChangePasswordRequest` → `MeResponse`  | viewer (own, session only)      |
| GET    | `/auth/oidc/start`    | redirect to issuer                      | — (OIDC configured)             |
| GET    | `/auth/oidc/callback` | redirect to `/` (or `/no-access`)       | —                               |
| POST   | `/auth/logout`        | → 204                                   | any                             |
| GET    | `/auth/whoami`        | → `WhoAmIResponse` (the audit identity) | viewer                          |

Local password sign-in works whether or not OIDC is configured; an account can have a password,
an OIDC identity, or both. `MeResponse.oidcIssuer` names the issuer for the "Sign in with …"
button. The first OIDC sign-in binds the account to the issuer's subject and writes an `audit_log`
row (`scope: user`, `field: oidc_subject`, the subject as `after`, reason "first OIDC sign-in").
An email already bound to another subject is refused, never re-bound.

`MeResponse.evaluationAdminEmail` is the bootstrap local admin's email (`admin@switchboard.local`,
or `SWITCHBOARD_BOOTSTRAP_ADMIN`) when the server runs in evaluation mode and that account has a
password, for the sign-in page's "Forgot password or email?" hint; otherwise `null`. No other
email is returned to a signed-out caller. Recovery itself has no API route: an admin uses
`PUT /users/:id/password`, and without one, `switchboard users reset-password` runs on the server
([runbook](runbook.md#locked-out)).

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

**Sign-in throttle.** Failed attempts are counted in Postgres across replicas: 10 failures per
client address or 5 per account (normalised email) within 5 minutes answer 429
`too_many_attempts` with `Retry-After: <seconds>` until the oldest counted failure leaves the
window. `POST /auth/password` allows 5 failed confirmations per user in the same window.

**Password rules:** at least 8 characters (at most 256), not the account's email (or the part
before `@`), not one of the most common passwords.

## Board and status

| Method | Path      | Response              | Role   |
| ------ | --------- | --------------------- | ------ |
| GET    | `/status` | `StatusStripResponse` | viewer |
| GET    | `/board`  | `BoardResponse`       | viewer |

`BoardResponse.attention` includes a `process_disabled` item (action `enable_process`) for a
disabled process that has never run and turned events away in the last 24 hours (its triggers
matched the source, and match recorded `process is disabled`). A process that ran before was
paused on purpose and gets no item.

## Plugin types

| Method | Path                  | Response          | Role   |
| ------ | --------------------- | ----------------- | ------ |
| GET    | `/plugin-types?kind=` | `PluginTypeDTO[]` | viewer |

`PluginTypeDTO.icon` is the icon the type declares (SDK 1.3): a built-in icon name from the
SDK's `ICON_NAMES`, or a `data:image/svg+xml;base64,…` URI of at most 8 KB. It is absent when
the type declares none. Instance summaries (`SourceSummary`, `DestinationSummary`,
`InstanceSummary`) and the board's source and destination nodes carry the same value as
`typeIcon` (`null` when there is none or the plugin is not loaded). Clients render a data URI
through `<img>` only, never as inline markup, and fall back to the kind's generic icon.

## Sources

| Method | Path                                | Body → Response                                  | Role     |
| ------ | ----------------------------------- | ------------------------------------------------ | -------- |
| GET    | `/sources`                          | → `SourceSummary[]`                              | viewer   |
| POST   | `/sources`                          | `CreateSourceRequest` → `SourceDetail`           | operator |
| GET    | `/sources/:id`                      | → `SourceDetail`                                 | viewer   |
| PUT    | `/sources/:id`                      | `UpdateSourceRequest` → `SourceDetail`           | operator |
| DELETE | `/sources/:id`                      | `Reasoned` → 204                                 | operator |
| POST   | `/sources/:id/enable`               | `EnableRequest` → `SourceDetail`                 | operator |
| POST   | `/sources/:id/provision`            | `Reasoned` → `ResultResponse`                    | operator |
| POST   | `/sources/:id/test-event`           | `TestEventRequest` → `EventIdsResponse`          | operator |
| POST   | `/sources/:id/reload`               | `Reasoned` → `SourceDetail`                      | operator |
| GET    | `/sources/:id/stats?window=`        | → `SourceStatsResponse`                          | viewer   |
| GET    | `/sources/:id/events?cursor=&type=` | → `Page<ActivityRow>`                            | viewer   |
| POST   | `/sources/preview`                  | `SourcePreviewRequest` → `SourcePreviewResponse` | operator |
| GET    | `/sources/:id/last-delivery`        | → `LastDeliveryResponse`                         | operator |

`POST /sources/preview` tries a sample delivery against draft settings, for push (and both)
source types; a pull-only type is 422, an unknown type 404. It builds a throwaway instance
(secret references resolved server-side; with `sourceId`, secret fields left empty keep that
source's stored references), runs `parse` — never `verify`, so no signature is needed — and
checks each event against the instance's declared schemas as ingest would. Nothing is stored or
counted against the plugin, and no reason is needed. Settings that fail the schema, a secret that
does not resolve, a `create` that throws and a `parse` that throws come back as `errors` with an
empty `events`; an event that would be stored as `event_invalid` has `valid: false` and its
`problems`. `notes` are the plugin's own explanations of what produced no event (SDK 1.4
`parseWithNotes`), and `declaredTypes` the draft instance's event types. Resolved secret values
are redacted from everything returned. `GET /sources/:id/last-delivery` returns the newest stored
push delivery with a body (`{ receivedAt, body, headers }`, 404 when there is none yet); headers
whose names suggest a credential or signature read `[redacted]`.

## Destinations

| Method | Path                                | Body → Response                                  | Role     |
| ------ | ----------------------------------- | ------------------------------------------------ | -------- |
| GET    | `/destinations`                     | → `DestinationSummary[]`                         | viewer   |
| POST   | `/destinations`                     | `CreateDestinationRequest` → `DestinationDetail` | operator |
| GET    | `/destinations/:id`                 | → `DestinationDetail`                            | viewer   |
| PUT    | `/destinations/:id`                 | `UpdateDestinationRequest` → `DestinationDetail` | operator |
| DELETE | `/destinations/:id`                 | `Reasoned` → 204                                 | operator |
| POST   | `/destinations/:id/enable`          | `EnableRequest` → `DestinationDetail`            | operator |
| POST   | `/destinations/:id/reload`          | `Reasoned` → `DestinationDetail`                 | operator |
| POST   | `/destinations/:id/meters/read`     | `Reasoned` → `MeterGaugeDTO[]`                   | operator |
| POST   | `/destinations/:id/soft-hold/clear` | `Reasoned` → `DestinationDetail`                 | operator |
| GET    | `/destinations/:id/meters?window=`  | → `MeterHistoryResponse`                         | viewer   |
| GET    | `/destinations/:id/usage?window=`   | → `UsageHistoryResponse`                         | viewer   |

`MeterGaugeDTO.ceilingState` says where a meter stands against the event ceilings of the
processes bound to it, decided by the budget stage itself: `throttling` (an event batch would be
throttled now), `stale` (a ceiling is set but the reading is missing or older than the staleness
window, so the ceiling does not apply), else `below`. Meters and usage dimensions come from the
live instance, or without one from what the type declares for the instance's settings.
`MeterHistoryResponse.runs[]` carries `statusLabel` next to `status`.

`DestinationCapsDTO` (on create and update) carries the core's caps: `runsPerHour`, `runsPerDay`,
`usagePerDay`, `meterPollSeconds` (30–86 400), `meterStalenessMinutes`, `estimatedLimits` and
`invokeTimeoutSeconds` (1–3600): how long to wait for `invoke` to answer. It overrides the type's
per-target and default timeouts (core default 300 s); no answer in time is a lost response
(retried when idempotent, otherwise the run is `uncertain`).

**Deprecated aliases** (from before "executor" was renamed "destination"): every
`/executors…` path is served by the matching `/destinations…` route, `kind=executor` is accepted
on `GET /plugin-types` and `GET /plugins/search`, and an `executor=` filter is read as
`destination=` (`packages/core/src/api/legacy.ts`). Responses use the current names
(`destinationId`, `destinations`). The aliases will be removed in a future major.

## Processes

| Method | Path                                       | Body → Response                                                                                   | Role     |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------- |
| GET    | `/processes`                               | → `ProcessSummary[]`                                                                              | viewer   |
| POST   | `/processes`                               | `CreateProcessRequest` → `ProcessDetail`                                                          | operator |
| GET    | `/processes/:id`                           | → `ProcessDetail`                                                                                 | viewer   |
| PUT    | `/processes/:id`                           | `UpdateProcessRequest` → `ProcessDetail` (409 on version conflict; `expectedVersion` is required) | operator |
| DELETE | `/processes/:id`                           | `Reasoned` → 204                                                                                  | operator |
| POST   | `/processes/:id/enable`                    | `EnableRequest` → `ProcessDetail`                                                                 | operator |
| POST   | `/processes/:id/run`                       | `RunNowRequest` → `RunNowResponse`                                                                | operator |
| POST   | `/processes/:id/breaker/reset`             | `Reasoned` → `ProcessDetail`                                                                      | operator |
| GET    | `/processes/:id/funnel?window=`            | → `FunnelResponse`                                                                                | viewer   |
| GET    | `/processes/:id/stats?window=`             | → `ProcessStatsResponse`                                                                          | viewer   |
| GET    | `/processes/:id/versions`                  | → `ProcessVersionSummary[]`                                                                       | viewer   |
| GET    | `/processes/:id/versions/:version`         | → `ProcessVersionDetail`                                                                          | viewer   |
| POST   | `/processes/:id/versions/:version/restore` | `Reasoned` → `ProcessDetail`                                                                      | operator |
| GET    | `/processes/:id/batches?limit=`            | → `RecentBatchDTO[]`                                                                              | viewer   |
| GET    | `/processes/:id/activity?cursor=`          | → `Page<ActivityRow>`                                                                             | viewer   |
| POST   | `/processes/preview/filter`                | `FilterPreviewRequest` → `FilterPreviewResponse`                                                  | viewer   |
| POST   | `/processes/preview/input`                 | `InputPreviewRequest` → `InputPreviewResponse`                                                    | viewer   |
| POST   | `/processes/preview/cron`                  | `CronPreviewRequest` → `CronPreviewResponse`                                                      | viewer   |

`DELETE /processes/:id` removes the process and, in the same transaction, ends what it left
unfinished: its open batches, closed batches not yet dispatched and batches awaiting approval
become `rejected` with reason `process_deleted` (a `batch`/`process_deleted` decision names the
actor and reason), and its pending approvals become `withdrawn` (`ApprovalHistoryItem.decision`,
one `approval` audit row each). Runs already reserved finish as usual; runs, events, versions and
schedule ticks stay for the trace, and the `deleted` audit row keeps the last document. A source,
destination or notifier the process used can be deleted afterwards.

## Activity, events, trace

| Method | Path                                                                             | Body → Response                                       | Role     |
| ------ | -------------------------------------------------------------------------------- | ----------------------------------------------------- | -------- |
| GET    | `/events?source=&process=&destination=&stage=&type=&artifact=&from=&to=&cursor=` | → `Page<ActivityRow>`                                 | viewer   |
| GET    | `/events/:id`                                                                    | → `EventDetail`                                       | viewer   |
| POST   | `/events/:id/replay`                                                             | `Reasoned` → `EventIdsResponse`                       | operator |
| GET    | `/trace?artifact=`                                                               | → `TraceResponse` (artifact id, `kind:id`, or `#482`) | viewer   |
| GET    | `/events/:id/trace`                                                              | → `TraceResponse`                                     | viewer   |

`ActivityRow.processes[]` carries `statusLabel` (the run status in words and tone, null while no
run exists) next to `runStatus`.

"Why nothing ran". Match records a decision for every trigger on the event's source, including
the ones it never evaluated (`skip`: `process_disabled`, `trigger_disabled`,
`type_not_subscribed`), so the reason is what was true when the event arrived.
`EventDetail.explanations` has one `EventExplanation` per process with a trigger on the source:
`{ processId, processName, taken, reason, basis, tone }`. The `reason` is one of
`trigger "…" matched` (plus `but it was deduped`), `process is disabled`, `trigger "…" is disabled`,
`event type <t> is not in trigger "…" (subscribes to …)`, `filter false: <expr>`,
`filter error: <msg>`, and for events stopped at the door `source is disabled`,
`type <t> is muted on the source`, `event invalid: …`, `source throttled`. `basis` is `recorded`,
or `now` when nothing was recorded for that process (events matched before skips were recorded,
or a trigger added since) and the reason comes from the current configuration. Processes created
after the event are left out. `ActivityRow.whyNothingRan` is the one-line summary for an
`unmatched` event (`Autofix: process is disabled (+1 more)`, or
`no process has a trigger on this source`), null otherwise. The trace adds a `filter` entry per
process that did not take the event, titled `<process> did not take it: <reason>` with
`data: { taken: false, reason, basis }` and tone `warn` (disabled process or trigger, filter
error, invalid event) or `off`, and `Nothing ran: no process has a trigger on this source` when
none listens.

## Runs

| Method | Path                                          | Body → Response                 | Role     |
| ------ | --------------------------------------------- | ------------------------------- | -------- |
| GET    | `/runs?process=&destination=&status=&cursor=` | → `Page<RunSummary>`            | viewer   |
| GET    | `/runs/:id`                                   | → `RunDetail`                   | viewer   |
| POST   | `/runs/:id/close`                             | `CloseRunRequest` → `RunDetail` | operator |

`RunDetail.steps[].status` is the step journal state: `started` (the action is running, or in
doubt when the run moved on), `ok`, `error`, `skipped` (dry run or `when` false) or `uncertain`
(left in doubt by an interrupted attempt; the action is not idempotent, so it was not repeated). A
run whose non-idempotent `before` step was in doubt is `failed` with the reason
`step_in_doubt:before[<index>] <action>`. In a trace, a notification entry with tone `warn` was
claimed but its delivery was not confirmed.

A run exists only once its budget check passed, so it has no binding limit: a throttled batch
carries its binding limit in the batch (`outcome_reason` and the budget decision in the trace).
`RunDetail.requestedBy` names who asked for a manual run (Run now or a test run); it is null for
event runs and sweeps.

## Approvals

| Method | Path                          | Body → Response                | Role     |
| ------ | ----------------------------- | ------------------------------ | -------- |
| GET    | `/approvals`                  | → `ApprovalItem[]`             | viewer   |
| GET    | `/approvals/history?cursor=`  | → `Page<ApprovalHistoryItem>`  | viewer   |
| GET    | `/approvals/rules`            | → `ApprovalRulesResponse`      | viewer   |
| POST   | `/approvals/:batchId/approve` | `Reasoned` → `ApproveResponse` | operator |
| POST   | `/approvals/:batchId/reject`  | `Reasoned` → 204               | operator |

## Plugins

| Method | Path                       | Body → Response                                                                           | Role   |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| GET    | `/plugins`                 | → `PluginSummary[]`                                                                       | viewer |
| GET    | `/plugins/catalogue`       | → `CatalogueEntry[]`                                                                      | viewer |
| GET    | `/plugins/search?kind=&q=` | → `PluginSearchResponse`; 503 `registry_unavailable` when the registry cannot be reached  | viewer |
| POST   | `/plugins/inspect`         | `InspectPluginRequest` → `InspectPluginResponse`                                          | admin  |
| POST   | `/plugins`                 | `InstallPluginRequest` → 201 `PluginSummary` (loaded at once; see below)                  | admin  |
| DELETE | `/plugins/:name`           | `Reasoned` → 204 (unloaded here at once; every replica removes its copy on its sync pass) | admin  |

`GET /plugins/search` queries the npm registry (`SWITCHBOARD_NPM_REGISTRY`) for the union of the
name prefix (`ai-switchboard-{kind}`) and `keywords:switchboard-plugin`, and keeps only packages
that follow the naming convention — `ai-switchboard-{kind}-{name}`,
`@scope/ai-switchboard-{kind}-{name}` or `@ai-switchboard/{kind}-{name}` — where `kind` is
`source`, `destination`, `notifier` or `secrets` (the optional `kind` query parameter). Each result
carries the latest version, description, publisher, publish date, links, weekly downloads when the
registry reports them, `installed`/`installedVersion` on this replica, and `reviewed` (in the
catalogue).

`POST /plugins` installs the package into `$SWITCHBOARD_HOME/plugins`, pins it in
`plugins.lock.json`, records the spec and version in the `plugins` row and loads it into the
running process: its types are usable immediately. Every other replica installs and loads the
recorded plugin at boot and on a sync pass every `SWITCHBOARD_PLUGIN_SYNC_SECONDS` (60 s).
`pendingRestart: true` means another version of the plugin is already loaded (an upgrade); the new
version loads on the next restart. `DELETE /plugins/:name` uninstalls it here, unregisters its
types (their instances report `plugin_unavailable`), clears the install record and sets a
tombstone (`plugins.remove_requested_at`): every replica's sync pass (and boot) removes its own
copy from `$SWITCHBOARD_HOME` and unregisters it, idempotently. A copy installed on a replica
after the removal (with the CLI) is kept, as are plugins that were never installed through the
API. Re-installing with `POST /plugins` clears the tombstone. A removed plugin leaves
`GET /plugins` once this replica's copy is gone; its types stay listed with `available: false`.

## Notifiers and secret providers

`/notifiers` and `/secret-providers` share one shape: `GET` → `InstanceSummary[]`, `POST` `CreateInstanceRequest`, `PUT /:id` `UpdateInstanceRequest`, `POST /:id/enable` `EnableRequest`, `POST /:id/reload`, `DELETE /:id`, and for notifiers `POST /:id/test` (`Reasoned` → `ResultResponse`). Role: admin for writes. A secret provider's name is the `<provider>` in `secret://<provider>/<name>`: lower-case letters, digits and dashes.

Secret providers: sources, destinations and notifiers resolve `secret://<provider>/…` references
when they are built, so creating, enabling or disabling, editing (including renaming) or
reloading a provider rebuilds every instance whose settings reference its name (and, after a
rename, its old name: those instances fail with `secret_error: secret provider "<old>" is not
configured or not running` until their references are updated; nothing is rewritten). Hot-loading
a secret-provider plugin does the same for the providers it brings up. Each secret-provider
`InstanceSummary` carries `dependents`: those instances with their status now, so a mutation's
response shows the rebuild's outcome. `DELETE /secret-providers/:id` answers 409 while any source,
destination, notifier or process (a `secret://` field, or `$secretRef('<provider>/<name>')` in an
expression) still references the provider, naming them.

Every instance mutation (create, `PUT`, enable, reload, delete, `POST /apply`) rebuilds the live
instance on the replica that answers, so its response reflects the result. Other replicas rebuild
it, and a provider's dependents, on their next reconcile pass, within
`SWITCHBOARD_INSTANCE_SYNC_SECONDS` (10 s): a `reload` bumps the row's `config_version` for that.

`GET /secret-providers/:id/secrets` → `ProviderSecretsResponse` (role: **admin**; secret names map
out the credentials a deployment holds, so viewers and operators get 403). It returns secret
**names only, never values**: each listed secret has its `secret://<provider>/<name>` `ref`, the
provider's optional `description` and `updatedAt`, and `usedBy` (every source, destination,
notifier, secret provider and process whose settings or document reference it, with the field
path). `missing` holds references to this provider whose names the provider does not list
(broken references). A name the host stored for an instance's rotated credentials
(`switchboard-<instanceId>-<key>`) carries `storedBy` (`SecretOwnerDTO`: the instance's `kind`, `id`
and `name`); the UI shows it as "stored by <instance>", read-only, and never offers it as a
settings reference. The core keeps only `name`, `description` and `updatedAt` from what the
plugin's `SecretProvider.list()` returns. A provider type without `list()`, a disabled or
stopped provider, or a failed or timed-out (10 s) listing gives `available: false` with an
`error`, and empty `secrets` and `missing`.

## Settings, users, tokens, audit, export

| Method | Path                                   | Body → Response                                     | Role                 |
| ------ | -------------------------------------- | --------------------------------------------------- | -------------------- |
| GET    | `/settings`                            | → `GlobalSettings`                                  | viewer               |
| PUT    | `/settings`                            | `UpdateSettingsRequest` → `GlobalSettings`          | admin                |
| GET    | `/users`                               | → `UserDTO[]`                                       | admin                |
| GET    | `/users/directory`                     | → `UserDirectoryEntry[]` (email and role only)      | viewer               |
| POST   | `/users`                               | `CreateUserRequest` → `UserDTO`                     | admin                |
| PUT    | `/users/:id`                           | `UpdateUserRequest` → `UserDTO`                     | admin                |
| DELETE | `/users/:id`                           | `Reasoned` → 204                                    | admin                |
| POST   | `/users/:id/sessions/revoke`           | `Reasoned` → 204 (signs the user out everywhere)    | admin                |
| PUT    | `/users/:id/password`                  | `SetPasswordRequest` → `UserDTO` (temporary)        | admin (not own)      |
| DELETE | `/users/:id/password`                  | `Reasoned` → `UserDTO` (OIDC-only from now on)      | admin (OIDC on)      |
| GET    | `/tokens`                              | → `ApiTokenDTO[]` (own)                             | viewer               |
| POST   | `/tokens`                              | `CreateApiTokenRequest` → `CreateApiTokenResponse`  | viewer (role ≤ own)  |
| DELETE | `/tokens/:id`                          | `Reasoned` → 204                                    | viewer (own) / admin |
| GET    | `/audit?scope=&target=&actor=&cursor=` | → `Page<AuditEntry>` (newest first, by time and id) | viewer               |
| GET    | `/export`                              | → YAML (`text/yaml`)                                | operator             |
| POST   | `/apply`                               | `ApplyRequest` → `ApplyResponse`                    | admin                |
| GET    | `/about`                               | → `AboutResponse`                                   | viewer               |

`GET /about` returns versions, the database, the replicas and `telemetry`
(`TelemetryStatusDTO`): for each signal (`traces`, `metrics`, `logs`) its exporters (`otlp`,
`console`, or none), OTLP protocol, endpoint as `scheme://host:port` only, and how many export
headers are configured, plus whether `/metrics` is served, the service name and the sampler. It
describes the replica that answered. Header names and values are never returned.

`GET /users/directory` lets every role see who has access and with which role (the read-only
Users tab); sign-in methods, last sign-in and every write stay admin-only.

`POST /users` takes an optional `password`: the user signs in with it once and must change it.
`PUT /users/:id/password` sets or resets a temporary password (the rules above apply), marks the
account `mustChangePassword` and signs the user out everywhere; an admin changes their own
password with `POST /auth/password` instead (409 here). `DELETE /users/:id/password` removes the
password and signs the user out; it is refused (409) while OIDC is not configured, since the
account could no longer sign in. The audit rows record `password` / `password_reset` with
`temporary`, `set` or `removed`, never the value.

`POST /tokens` takes an optional `name` (blank or missing: `token`) and a `role` no higher than
the caller's.

`POST /apply` checks every instance exactly as the instance routes do: settings against the
type's schema with no literal secret values, caps against `SourceCapsDTO` / `DestinationCapsDTO`,
names (a secret provider's name rule), and for a push source the verification rule, with
`caps.unauthenticated` derived from an instance built from the file's settings. A problem is
reported in `errors` as `<kind> "<name>": <problem>` and the whole change rolls back. Created
instances are audited against their id (`created`); changed ones get one audit row per changed
field, with the reason `apply: <reason>`.
