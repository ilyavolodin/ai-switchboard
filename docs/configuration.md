# Configuration

Switchboard is configured in three layers:

1. **Environment variables** for the deployment: database, public URL, sign-in, telemetry. Read
   at start (`packages/core/src/config.ts`).
2. **Global settings** for the installation: timezone, staleness, retention, the system notifier.
   Edited on the Settings page or through `PUT /api/v1/settings`, stored in Postgres, audited.
3. **Instances and processes**: secret providers, sources, destinations, notifiers and processes.
   Edited in the UI, or kept in git as one YAML file and applied with `switchboard apply`.

Secret values are never in any of the stored layers. Settings hold `secret://<provider>/<name>`
references, and a secret provider resolves them when an instance is built.

## Environment variables

### Server

| Variable                            | Default                                                         | Meaning                                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                      | `postgres://switchboard:switchboard@localhost:5432/switchboard` | Postgres connection string. The only state, including the job queue                                                                                                                        |
| `HOST`                              | `0.0.0.0`                                                       | Listen address                                                                                                                                                                             |
| `PORT` (or `SWITCHBOARD_PORT`)      | `8080`                                                          | Listen port                                                                                                                                                                                |
| `SWITCHBOARD_PUBLIC_URL`            | `http://localhost:<port>`                                       | Public base URL. Used for webhook URLs (`/hooks/<id>`), callback URLs (`/callbacks/<id>`) and OIDC redirects. No trailing slash                                                            |
| `SWITCHBOARD_HOME`                  | `./.switchboard`                                                | Installed plugins (`plugins/`) and `plugins.lock.json`. `/opt/switchboard` in the image                                                                                                    |
| `SWITCHBOARD_EVALUATION`            | `false`                                                         | Evaluation mode: unauthenticated `webhook` instances allowed, a plain-http OIDC issuer accepted, and the evaluation banner shown while OIDC is not configured                              |
| `SWITCHBOARD_BOOTSTRAP_ADMIN`       | —                                                               | Email of the first admin. With OIDC configured, that admin signs in through the issuer and gets no password. Without OIDC it names the local admin (default `admin@switchboard.local`)     |
| `SWITCHBOARD_ADMIN_PASSWORD`        | — (generated)                                                   | Password for the bootstrap local admin. When unset, a password is generated, printed once to the log and must be changed at first sign-in. When set, it is used as given (automation, e2e) |
| `SWITCHBOARD_OIDC_ISSUER`           | —                                                               | OIDC issuer URL. Local password sign-in works with or without it                                                                                                                           |
| `SWITCHBOARD_OIDC_CLIENT_ID`        | —                                                               | OIDC client id                                                                                                                                                                             |
| `SWITCHBOARD_OIDC_CLIENT_SECRET`    | —                                                               | OIDC client secret. Only ever in the environment, never exported                                                                                                                           |
| `SWITCHBOARD_OIDC_ALLOWED_DOMAINS`  | —                                                               | Comma-separated email domains allowed to sign in                                                                                                                                           |
| `LOG_LEVEL`                         | `info`                                                          | pino log level (`trace`, `debug`, `info`, `warn`, `error`)                                                                                                                                 |
| `SWITCHBOARD_PRETTY_LOGS`           | `false`                                                         | Human-readable logs instead of JSON (development)                                                                                                                                          |
| `SWITCHBOARD_PROMETHEUS`            | `true`                                                          | Serve Prometheus metrics at `/metrics`                                                                                                                                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`       | —                                                               | Export traces, metrics and logs over OTLP to this collector or vendor. The `OTEL_*` variables are listed under [Telemetry](#telemetry)                                                     |
| `SWITCHBOARD_REPLICA_ID`            | `<hostname>-<random>`                                           | Replica name in heartbeats and the About panel                                                                                                                                             |
| `SWITCHBOARD_UI_DIR`                | `packages/core/public`                                          | Directory with the built UI                                                                                                                                                                |
| `SWITCHBOARD_PLUGIN_DIRS`           | —                                                               | Comma-separated extra directories scanned for plugin packages (each a `node_modules`)                                                                                                      |
| `SWITCHBOARD_DEV_SOURCE`            | `false`                                                         | Load plugins from their `switchboard.source` TypeScript entry (development under tsx)                                                                                                      |
| `SWITCHBOARD_NPM_REGISTRY`          | `https://registry.npmjs.org`                                    | npm registry that Plugins → Browse npm searches (`GET /api/v1/plugins/search`). Installs use npm itself, so they honour `.npmrc`                                                           |
| `SWITCHBOARD_PLUGIN_SYNC_SECONDS`   | `60`                                                            | How often each replica installs and loads plugins that an admin installed through the API on another replica (also done at boot)                                                           |
| `SWITCHBOARD_INSTANCE_SYNC_SECONDS` | `10`                                                            | How often each replica rebuilds the sources, destinations, notifiers and secret providers changed, reloaded or deleted through another replica (also done at boot). Minimum 1              |
| `SWITCHBOARD_WORKERS`               | `true`                                                          | Run pipeline workers and the scheduler in this process. `false` for an API-and-ingress-only replica                                                                                        |
| `SWITCHBOARD_SECURE_COOKIES`        | `true` when the public URL is `https://`                        | Mark the session cookie `Secure`                                                                                                                                                           |
| `SWITCHBOARD_TRUST_PROXY`           | `false`                                                         | Trust `X-Forwarded-For`/`-Proto` from a reverse proxy (set `true` behind an ingress or load balancer; the Helm chart does). Client addresses in logs and the sign-in throttle come from it |

Booleans accept `1`, `true`, `yes` and `on` (any case). Anything else is false.

`SWITCHBOARD_OIDC_TRUST_UNVERIFIED_EMAIL` (default `false`) accepts an ID token whose
`email_verified` claim is missing or false, for an issuer that never sends it. Such a sign-in is
still refused for an account that has a password and no OIDC identity yet
([Security](security.md#sign-in-and-roles)). The Helm chart sets it from
`oidc.trustUnverifiedEmail`. An issuer saved in Settings (used when `SWITCHBOARD_OIDC_ISSUER` is
unset) carries its own `oidc.trustUnverifiedEmail` (absent means `false`); the variable does not
apply to it.

### Telemetry

The standard OpenTelemetry SDK variables. Nothing is exported until an OTLP endpoint (generic
or per signal) is set; an invalid value logs a `telemetry configuration` warning at start and
the default applies. [Observability](observability.md) has vendor examples and the signals.

| Variable                                                                                                                                          | Default                        | Meaning                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_SDK_DISABLED`                                                                                                                               | `false`                        | `true` turns OpenTelemetry off entirely: no export and no `/metrics`                                                                                           |
| `OTEL_SERVICE_NAME`                                                                                                                               | `switchboard`                  | `service.name` of every signal                                                                                                                                 |
| `OTEL_RESOURCE_ATTRIBUTES`                                                                                                                        | —                              | `key=value,...` resource attributes, e.g. `deployment.environment.name=prod`. `service.version` and `service.instance.id` (`SWITCHBOARD_REPLICA_ID`) are added |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                                                                     | —                              | OTLP base URL. HTTP appends `/v1/traces`, `/v1/metrics`, `/v1/logs`; gRPC uses it as is                                                                        |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT`                                                                                               | —                              | Per-signal URL, used as is (overrides the generic one; setting only one exports only that signal)                                                              |
| `OTEL_EXPORTER_OTLP_PROTOCOL` (and `_{SIGNAL}_PROTOCOL`)                                                                                          | `http/protobuf`                | `http/protobuf`, `http/json` or `grpc`                                                                                                                         |
| `OTEL_EXPORTER_OTLP_HEADERS` (and `_{SIGNAL}_HEADERS`)                                                                                            | —                              | `key=value,...` (values percent-encoded) sent with every export: vendor API keys. Never logged or shown; Settings › About shows only how many there are        |
| `OTEL_EXPORTER_OTLP_TIMEOUT` (and `_{SIGNAL}_TIMEOUT`)                                                                                            | `10000`                        | Export timeout, milliseconds                                                                                                                                   |
| `OTEL_EXPORTER_OTLP_COMPRESSION` (and `_{SIGNAL}_COMPRESSION`)                                                                                    | `none`                         | `gzip` or `none`                                                                                                                                               |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`                                                                             | `otlp` when an endpoint is set | Comma-separated `otlp`, `console`, `none` (metrics also `prometheus`). `none` turns the signal off                                                             |
| `OTEL_METRIC_EXPORT_INTERVAL`                                                                                                                     | `30000`                        | Metric push interval, milliseconds                                                                                                                             |
| `OTEL_METRIC_EXPORT_TIMEOUT`                                                                                                                      | `30000`                        | Metric export timeout, milliseconds                                                                                                                            |
| `OTEL_TRACES_SAMPLER`                                                                                                                             | `parentbased_always_on`        | `always_on`, `always_off`, `traceidratio`, `parentbased_always_on`, `parentbased_always_off`, `parentbased_traceidratio`                                       |
| `OTEL_TRACES_SAMPLER_ARG`                                                                                                                         | `1`                            | Ratio (0–1) for the `traceidratio` samplers                                                                                                                    |
| `OTEL_LOG_LEVEL`                                                                                                                                  | `warn`                         | Level of the OpenTelemetry SDK's own diagnostics (export failures), logged with `component: otel` and never exported                                           |
| `OTEL_BSP_*`, `OTEL_BLRP_*`, `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`, `OTEL_EXPORTER_OTLP_INSECURE`, `OTEL_EXPORTER_OTLP_CERTIFICATE` | SDK defaults                   | Read by the OpenTelemetry SDK itself (batch sizes and delays, temporality, TLS)                                                                                |

Secret providers read their own environment. The `env` provider resolves
`secret://env/GITHUB_TOKEN` from the variable `GITHUB_TOKEN` of the switchboard process, so the
variables your references name belong in the same environment (the Compose file, the Helm
chart's `extraEnv` or an existing Kubernetes secret).

### CLI

| Variable            | Default                 | Used by                                                                |
| ------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `SWITCHBOARD_URL`   | `http://localhost:8080` | `export`, `apply` (`--url`)                                            |
| `SWITCHBOARD_TOKEN` | —                       | `export`, `apply` (`--token`), sent as `Authorization: Bearer <token>` |
| `SWITCHBOARD_HOME`  | `./.switchboard`        | `plugins add/remove/list` (`--home`)                                   |

`switchboard doctor`, `switchboard serve` and `switchboard users` read the server variables
above, so run them with the same environment as the server (for example `docker compose exec
switchboard switchboard doctor`). `switchboard users` changes the database directly, for account
recovery when nobody can sign in ([runbook](runbook.md#locked-out)).

Create a token on **Settings → API tokens** or with `POST /api/v1/tokens`. A token carries a role
no higher than its owner's: `export` needs operator, `apply` needs admin.

## Global settings

`GET /api/v1/settings` returns and `PUT /api/v1/settings` (admin, with a reason) partially
updates:

| Setting                 | Default | Meaning                                                                                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `timezone`              | `UTC`   | Installation timezone: the default for quiet hours and schedules                                                                           |
| `defaultQuietHours`     | `null`  | `{ start: 'HH:MM', end: 'HH:MM', days?: [1..7] }` offered to new processes                                                                 |
| `meterStalenessMinutes` | `30`    | A meter reading older than this is stale: ceilings stop using it and only counters gate                                                    |
| `retention`             | below   | Days to keep each kind of row                                                                                                              |
| `oidc`                  | `null`  | `{ issuer, clientId, allowedDomains, trustUnverifiedEmail? }` (read at start). Not in the YAML; the client secret stays in the environment |
| `systemNotifierId`      | `null`  | Notifier instance for system alerts: breaker openings, plugin load failures, ceilings crossed, silent sources                              |
| `sourceSilenceMinutes`  | `1440`  | A source with no events for this long raises a silence alert                                                                               |
| `export`                | off     | `{ schedule, sourceId, repository, path, branch }`: commit the YAML export to a git repository on a cron schedule                          |

Retention defaults: `eventsDays` 90, `rawBodiesDays` 30, `dispatchesDays` 90,
`meterReadingsDays` 90, `statsHourlyDays` 730. Runs, steps, approvals, audit and process versions
are kept indefinitely. A nightly job prunes.

## YAML configuration

`switchboard export` (`GET /api/v1/export`) writes the whole configuration as one YAML document,
and `switchboard apply -f` (`POST /api/v1/apply`) creates or updates what a document lists. This
is how a team keeps its configuration in git and moves it between staging and production. The
format is `apiVersion: switchboard/v1`, `kind: Configuration`, and it is implemented by
`packages/core/src/services/config-io.ts`.

### Example

```yaml
apiVersion: switchboard/v1
kind: Configuration

# Partial GlobalSettings (without oidc): omitted keys stay as they are.
settings:
  timezone: Europe/London
  meterStalenessMinutes: 30
  defaultQuietHours: { start: '22:00', end: '07:00' }
  retention: { eventsDays: 90, rawBodiesDays: 30 }
  systemNotifierId: Slack — ops # holds a notifier NAME in the file
  sourceSilenceMinutes: 1440
  export:
    schedule: '0 3 * * *'
    sourceId: GitHub — acme org # holds a source NAME in the file
    repository: acme/switchboard-config
    path: switchboard.yaml
    branch: main

secretProviders:
  - { name: env, type: env, enabled: true, settings: {} }

sources:
  - name: GitHub — acme org
    type: github
    enabled: true
    settings:
      owner: acme
      authMode: token
      token: secret://env/GITHUB_TOKEN
      webhookSecret: secret://env/GITHUB_WEBHOOK_SECRET
    caps: { eventCapPerHour: 500 }

destinations:
  - name: Claude Routines — automation seat
    type: claude-routines
    enabled: true
    settings:
      token: secret://env/ROUTINE_TOKEN
      callbackSecret: secret://env/ROUTINE_CALLBACK_SECRET
    targetDefaults: {}
    caps: { runsPerDay: 22, estimatedLimits: { daily_runs: 22 } }

notifiers:
  - name: Slack — ops
    type: slack
    enabled: true
    settings: { mode: webhook, webhookUrl: secret://env/SLACK_WEBHOOK }

processes:
  - name: Autofix
    enabled: true
    description: Start the autofix routine for simple, labeled pull requests.
    triggers:
      - id: t1
        source: GitHub — acme org # instead of sourceId
        eventTypes: [github.pr.labeled]
        filter: "attributes.label = 'auto:fix-candidate'"
        describe: PR labeled auto:fix-candidate
        enabled: true
    schedules:
      - { id: nightly, cron: '0 2 * * *', timezone: Europe/London, catchUp: once, enabled: true }
    batching: { debounceSeconds: 120, maxSize: 10, maxAgeSeconds: 900 }
    gates:
      quietHours: { start: '22:00', end: '07:00' }
      approval: none
      breaker: { threshold: 3, cooldownMinutes: 120 }
    budgets:
      runsPerDay: 20
      meterCeilings: { five_hour: { events: 85, sweeps: 95 } }
    destination:
      instance: Claude Routines — automation seat # instead of instanceId
      target: { routineId: trig_autofix_0000000000 }
    input: '{ "text": "switchboard run " & run.id & " mode=" & mode }'
    before: []
    after:
      - provider: GitHub — acme org # an instance NAME
        action: addLabel
        args: '{ "artifact": events[0].artifact, "label": "auto:fix-started" }'
    notify:
      - { notifier: Slack — ops, template: "'Autofix ' & run.status", on: [error] }
    trackingDeadlineMinutes: 180
```

More complete files are in [examples/](../examples/README.md).

### Top-level keys

| Key               | Shape                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apiVersion`      | `switchboard/v1` (required)                                                                                                                                                                                                                |
| `kind`            | `Configuration` (required)                                                                                                                                                                                                                 |
| `settings`        | Partial global settings without `oidc`. `systemNotifierId` and `export.sourceId` hold instance names                                                                                                                                       |
| `secretProviders` | `[{ name, type, enabled?, settings? }]`                                                                                                                                                                                                    |
| `sources`         | `[{ name, type, enabled?, settings?, caps? }]`. `caps`: `eventCapPerHour`, `eventCapPerDay`, `eventTypesEnabled`, `pollIntervalSeconds` (`unauthenticated` is derived from the plugin's settings, e.g. the webhook's `verification: none`) |
| `destinations`    | `[{ name, type, enabled?, settings?, targetDefaults?, caps? }]`. `caps`: `runsPerHour`, `runsPerDay`, `usagePerDay`, `meterPollSeconds`, `meterStalenessMinutes`, `estimatedLimits`, `invokeTimeoutSeconds`                                |
| `notifiers`       | `[{ name, type, enabled?, settings? }]`                                                                                                                                                                                                    |
| `processes`       | Process documents with instance names in place of ids (below)                                                                                                                                                                              |

Every section is optional. `type` is the plugin type id (`github`, `webhook`, `http`,
`claude-routines`, `env`). Other top-level keys are not part of the format; apply ignores them.
Deprecated: apply still accepts the names from before "executor" was renamed "destination" (a
top-level `executors:` list and a process `executor:` binding); export always writes
`destinations:` and `destination:`.

A process is the stored `ProcessDocument` (see [concepts](concepts.md#the-process)) with every
instance id replaced by the instance's name:

| In the stored document      | In YAML                      |
| --------------------------- | ---------------------------- |
| `triggers[].sourceId`       | `triggers[].source`          |
| `destination.instanceId`    | `destination.instance`       |
| `before[].provider` (an id) | `before[].provider` (a name) |
| `after[].provider` (an id)  | `after[].provider` (a name)  |
| `notify[].notifierId`       | `notify[].notifier`          |

Everything else is verbatim, including trigger and schedule `id`s, which dispatches refer to. A
step's `provider` is looked up among sources first, then destinations. After the names are
translated, the document is validated exactly like a save in the editor, so every key is
required: `name`, `description`, `enabled`, `triggers`, `schedules`, `batching`, `gates`
(`approval`, `breaker`), `budgets` (`meterCeilings`), `destination`, `input`, `before`, `after`,
`notify`, `trackingDeadlineMinutes`.

### How apply works

- **Identity is the name** within each kind. Apply matches a source named `GitHub — acme org` to
  the existing source of that name and updates it, or creates it. An instance's `type` cannot
  change: apply reports an error instead. Renaming in the file creates a second instance, so
  rename in the UI and then export.
- **Additive.** Apply never deletes. An instance or process that is not in the file is left as it
  is. Remove things in the UI or through the API (`DELETE /api/v1/sources/:id`, ...).
- **Whole entries.** A listed instance is written as the file says: `settings`, `caps` and
  `targetDefaults` replace the stored ones (omitted means `{}`), and an omitted `enabled` means
  `true`. Settings are partial: only the keys present change, and `retention` and `export` merge
  key by key.
- **Order.** Secret providers → sources → destinations → notifiers → settings → processes, so
  settings and processes may name instances created by the same file.
- **Validation.** Each instance's `settings` are validated against its plugin type's
  `settingsSchema` (a type no loaded plugin provides is an error). Each process is validated
  against the process document schema and its references. A name that does not resolve is an
  error naming where it was used (`process "Autofix": no source named "..."`).
- **All or nothing.** Everything runs in one transaction. If there is any error, the transaction
  is rolled back and nothing is written; the response still lists every error found.
- **Dry run.** `dryRun: true` (`--dry-run`) runs the same apply and rolls it back, so the change
  list and errors are exactly what a real apply would produce.
- **Changes.** The response lists `{ kind, name, action }`, where `kind` is `secret_provider`,
  `source`, `destination`, `notifier`, `settings` (name `global`) or `process`, and `action` is
  `create`, `update` or `unchanged`. The CLI prints the list and the errors and exits 1 when
  there are errors.
- **Audit and versions.** Every change writes an audit row with the token owner as actor and the
  reason prefixed `apply: `. A created or changed process gets a new process version, like a
  save in the editor.
- **OIDC** is neither exported nor applied. Configure it with the `SWITCHBOARD_OIDC_*`
  environment variables.
- **Secrets.** Instance settings are exported as stored, and stored settings hold references:
  `secret://env/NAME` stays a reference both ways and no value is ever in the file. Keep every
  secret field a reference.
- **Not exported:** users, API tokens, sessions, runs, events, batches, approvals, meter readings,
  statistics, the audit log and installed plugins (install those with `switchboard plugins add`
  or bake them into the image).
- **Roles.** Export needs operator. Apply needs admin.

### Applying from CI

Keep `switchboard.yaml` in a repository. Check it on every pull request with a dry run and apply
it on the default branch:

```yaml
# .github/workflows/switchboard.yml
name: switchboard
on:
  pull_request:
    paths: [switchboard.yaml]
  push:
    branches: [main]
    paths: [switchboard.yaml]

jobs:
  apply:
    runs-on: ubuntu-latest
    env:
      SWITCHBOARD_URL: https://switchboard.example.com
      SWITCHBOARD_TOKEN: ${{ secrets.SWITCHBOARD_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - name: Dry run
        if: github.event_name == 'pull_request'
        run: npx @ai-switchboard/cli apply -f switchboard.yaml --dry-run --reason "PR #${{ github.event.number }}"
      - name: Apply
        if: github.event_name == 'push'
        run: npx @ai-switchboard/cli apply -f switchboard.yaml --reason "${{ github.sha }} by ${{ github.actor }}"
```

Use an admin API token dedicated to CI, so the audit log names it.
