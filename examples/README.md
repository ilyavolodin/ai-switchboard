# Examples

Each file is a complete configuration in the `switchboard/v1` YAML format
([docs/configuration.md](../docs/configuration.md#yaml-configuration)). Apply one with the CLI:

```bash
export SWITCHBOARD_URL=http://localhost:8080
export SWITCHBOARD_TOKEN=<an admin API token from Settings → API tokens>

switchboard apply -f examples/log-executor.yaml --dry-run --reason "try the example"
switchboard apply -f examples/log-executor.yaml --reason "try the example"
```

`--dry-run` prints the change list (`create`, `update`, `unchanged`) without writing anything.
Apply never installs plugins: an instance whose type no loaded plugin provides is reported as an
error, and nothing is written. Each file's header comment names the plugins it needs. Secrets are
`secret://env/<NAME>` references, so each file expects the named environment variables on the
switchboard container.

| File                                                       | What it wires                                                                                        | Needs                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`log-executor.yaml`](log-executor.yaml)                   | A quick-mode `webhook` (no mapping, no secrets) → one process → the built-in `log` executor          | Nothing: the plain Compose stack. The end state of the [quick start](../docs/quick-start.md)                     |
| [`webhook-to-http.yaml`](webhook-to-http.yaml)             | A signed `webhook` source → one process → the `http` executor calling the stub's `/exec`             | The Compose stack with the `stub` profile. `WEBHOOK_SECRET` is already set there                                 |
| [`github-linear-autofix.yaml`](github-linear-autofix.yaml) | GitHub PR labeled + Linear issue filter → Claude Routines, with meters, quiet hours, approval, steps | `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `LINEAR_WEBHOOK_SECRET`, `ROUTINE_*`, `SLACK_WEBHOOK` |
| [`datadog-triage.yaml`](datadog-triage.yaml)               | Datadog monitor triggered → a GitHub Actions workflow, one run per service tag                       | `DATADOG_WEBHOOK_SECRET`, `DATADOG_API_KEY`, `DATADOG_APP_KEY`, `GITHUB_APP_PRIVATE_KEY`                         |

## webhook-to-http.yaml

The signed-webhook and real-HTTP variant from the quick start's [going further](../docs/quick-start.md#going-further-signed-webhooks-and-a-real-http-call) section.
The `webhook` source verifies an HMAC-SHA256 signature in `x-signature-256` and maps the stub's
sample alert body to a `webhook.alert.fired` event with `service`, `severity` and `message`
attributes. The process `Alert to stub` has one trigger (critical alerts only), a 5-second
debounce, a runs-per-hour cap and a daily `cost_usd` cap, and calls `POST http://stub:9090/exec`
with sync tracking. The stub answers with `usage.cost_usd`, which the target's `usageFrom`
expression turns into the run's usage report.

After applying, send a delivery through the stub (the source id is on the source's page):

```bash
curl -X POST "http://localhost:9090/send?target=http://switchboard:8080/hooks/<sourceId>&secret=change-me-webhook-secret"
```

## github-linear-autofix.yaml

The loop Switchboard was first built for. A GitHub `github.pr.labeled` event with the label
`auto:fix-candidate` matches only when the Linear issue linked from the PR carries
`complexity:simple` (`$linked` then `$resolve`, both live reads). A Linear `linear.issue.labeled`
trigger covers the other order of events. Batches group by artifact, wait out quiet hours at
night, and need an approval when a PR also carries `auto:needs-approval`. The Claude Routines executor enforces meter
ceilings: event-driven runs stop at 85 % of the five-hour window while the 02:00 sweep may use
up to 95 %, and the daily run allowance (`daily_runs`) is estimated from the typed-in limit of 22.
When a run ends `ok`, an `after` step labels the PR `auto:fix-started`.
Errors and throttles go to Slack.

## datadog-triage.yaml

A Datadog `datadog.monitor.triggered` event for a P1/P2 production monitor starts the
`triage.yml` GitHub Actions workflow in `acme/ops-automation`. `batching.groupBy` extracts the
`service:<name>` tag, so a burst of alerts across three services produces three runs, one per
service, each carrying every monitor id of its batch. Usage is capped on billable minutes, and
the `api_rate_limit` meter ceiling keeps the GitHub App's rate limit clear.

## Field names

Settings and targets for `webhook`, `http`, `github`, `claude-routines`, `github-actions` and
`slack` match the reference plugins' schemas. The `linear` and `datadog` settings follow the
Technical Design; check each plugin's settings form (or `GET /api/v1/plugin-types`) for the exact
field names of the version you run.
