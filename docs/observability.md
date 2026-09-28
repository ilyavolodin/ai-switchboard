# Observability

Switchboard emits OpenTelemetry metrics, traces and logs for every pipeline decision, exposes a
Prometheus endpoint for installations without an OTLP collector, and keeps its own hourly
statistics so the UI needs no external system to show what happened.

## Setup

| Variable                      | Default | Effect                                                             |
| ----------------------------- | ------- | ------------------------------------------------------------------ |
| `SWITCHBOARD_PROMETHEUS`      | `true`  | Serve Prometheus exposition at `GET /metrics` on the server's port |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —       | Also export metrics and traces over OTLP/HTTP to this collector    |
| `LOG_LEVEL`                   | `info`  | Log level of the JSON logs on stdout                               |

Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: switchboard
    metrics_path: /metrics
    static_configs:
      - targets: ['switchboard:8080']
```

On Kubernetes, set `serviceMonitor.enabled=true` in the Helm chart when the Prometheus Operator
is installed. With an OpenTelemetry Collector, point `OTEL_EXPORTER_OTLP_ENDPOINT` at it
(`http://otel-collector:4318`) and forward to Datadog, Grafana Cloud, Honeycomb or anything else.

## Signals

One metric and one structured log line per pipeline decision, with the same attributes on both.
Prometheus names follow the OpenTelemetry conversion: dots become underscores, counters get
`_total`, and the histograms (unit seconds) get `_seconds` with `_bucket`, `_sum` and `_count`.

| Signal                           | Prometheus name                           | Kind      | Attributes                             | Meaning                                                                                                                                           |
| -------------------------------- | ----------------------------------------- | --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `switchboard.events`             | `switchboard_events_total`                | counter   | `source`, `type`, `stage`              | Events received, per outcome at the door                                                                                                          |
| `switchboard.dispatches`         | `switchboard_dispatches_total`            | counter   | `process`, `source`, `outcome`         | Match and dedupe results                                                                                                                          |
| `switchboard.batches`            | `switchboard_batches_total`               | counter   | `process`, `kind`, `outcome`, `reason` | Gate and budget results (held, throttled, invoked)                                                                                                |
| `switchboard.runs`               | `switchboard_runs_total`                  | counter   | `process`, `destination`, `status`     | Run terminal states                                                                                                                               |
| `switchboard.run.latency`        | `switchboard_run_latency_seconds_bucket`  | histogram | `process`                              | Event `occurredAt` → invoke                                                                                                                       |
| `switchboard.run.duration`       | `switchboard_run_duration_seconds_bucket` | histogram | `process`, `destination`               | Invoke → terminal                                                                                                                                 |
| `switchboard.run.usage`          | `switchboard_run_usage_total`             | counter   | `process`, `destination`, `unit`       | Usage per declared dimension, as the destination plugin reported it                                                                               |
| `switchboard.schedule.lag`       | `switchboard_schedule_lag_seconds_bucket` | histogram | `process`                              | Cron tick → sweep invoke                                                                                                                          |
| `switchboard.meter.utilization`  | `switchboard_meter_utilization`           | gauge     | `destination`, `meter`, `estimated`    | Latest reading, 0–100                                                                                                                             |
| `switchboard.meter.resets_in`    | `switchboard_meter_resets_in`             | gauge     | `destination`, `meter`                 | Seconds until the meter resets                                                                                                                    |
| `switchboard.budget.used`        | `switchboard_budget_used`                 | gauge     | `scope`, `window`                      | Counter versus cap                                                                                                                                |
| `switchboard.breaker`            | `switchboard_breaker`                     | gauge     | `process`                              | 1 while open                                                                                                                                      |
| `switchboard.source.health`      | `switchboard_source_health`               | gauge     | instance                               | 1 healthy                                                                                                                                         |
| `switchboard.destination.health` | `switchboard_destination_health`          | gauge     | instance                               | 1 healthy                                                                                                                                         |
| `switchboard.plugin.errors`      | `switchboard_plugin_errors_total`         | counter   | `plugin`, `kind`                       | Exceptions and invalid events attributed to a plugin                                                                                              |
| `switchboard.instance.rebuilds`  | `switchboard_instance_rebuilds_total`     | counter   | `kind`, `change`                       | Instances a replica's reconcile pass built (`created`), rebuilt (`changed`, `dependent`) or dropped (`removed`) after a change on another replica |
| `switchboard.heartbeat`          | `switchboard_heartbeat_total`             | counter   | `replica`                              | Emitted every 30 s by each live replica                                                                                                           |

Attribute values are the outcome vocabulary from [concepts](concepts.md#outcome-vocabulary):
event stages, dispatch outcomes, batch outcomes with hold reasons, run statuses.

## Traces and logs

A trace spans one event from receipt to terminal run, with a child span per stage and per plugin
call. The plugin `HttpClient` propagates W3C trace context, so a destination's outbound call
appears in the same trace, and so does the backend if it is instrumented.

Logs are JSON lines on stdout (pino). Decision lines carry the signal's attributes plus
`event_id`, `process_id`, `batch_id`, `run_id` and `external_url` wherever they exist, so a log
search for a run id returns its whole story. Secret values never appear in logs.

## Built-in statistics

Every chart in the UI (events by source and type, funnel counts per process, runs by status,
latency and duration percentiles, meter history, budget history) comes from an hourly
materialisation in Postgres (`stats_hourly`), kept for two years by default. Nothing in the UI
queries an external observability system.

## Grafana dashboard

`deploy/grafana/switchboard-dashboard.json` is a starting point over the Prometheus metrics:
events by source and stage, dispatch outcomes, batches held and throttled by reason, runs by
status, latency and duration p50/p95, meter utilization per destination and meter, budget usage,
open breakers, plugin errors and replica heartbeats.

To import it: Grafana → **Dashboards → New → Import** → upload the JSON → pick your Prometheus
data source for the `datasource` input. Use the dashboard's template variables to narrow it to
one process, destination or source.

## Example alerts

Alerting on pipeline events (breaker opened, plugin failed to load, ceiling crossed, silent
source, failed callback verification) is built in through the system notifier. For threshold
alerts in your own stack:

```yaml
groups:
  - name: switchboard
    rules:
      - alert: SwitchboardBreakerOpen
        expr: max by (process) (switchboard_breaker) == 1
        for: 5m
        annotations:
          summary: 'Breaker open on process {{ $labels.process }}'

      - alert: SwitchboardRunErrors
        expr: sum by (process) (increase(switchboard_runs_total{status=~"error|unknown|failed"}[1h])) >= 3
        annotations:
          summary: '{{ $labels.process }}: {{ $value }} failed runs in the last hour'

      - alert: SwitchboardMeterHigh
        expr: max by (destination, meter) (switchboard_meter_utilization) > 90
        for: 15m
        annotations:
          summary: '{{ $labels.destination }} {{ $labels.meter }} at {{ $value }} %'

      - alert: SwitchboardThrottling
        expr: sum by (process) (increase(switchboard_batches_total{outcome="throttled"}[6h])) > 10
        annotations:
          summary: '{{ $labels.process }} throttled {{ $value }} times in 6 h'

      - alert: SwitchboardPluginErrors
        expr: sum by (plugin) (increase(switchboard_plugin_errors_total[15m])) > 0
        annotations:
          summary: 'Plugin {{ $labels.plugin }} is raising errors'

      - alert: SwitchboardNoReplicas
        expr: sum(rate(switchboard_heartbeat_total[5m])) == 0
        for: 5m
        annotations:
          summary: 'No Switchboard replica has sent a heartbeat for 5 minutes'

      - alert: SwitchboardLatencyHigh
        expr: histogram_quantile(0.95, sum by (le, process) (rate(switchboard_run_latency_seconds_bucket[30m]))) > 900
        annotations:
          summary: '{{ $labels.process }} p95 event-to-invoke latency above 15 minutes'
```
