# Observability

Switchboard emits OpenTelemetry **traces, metrics and logs**. Each event reads as one trace
from the webhook that delivered it to its terminal run, across replicas and queue jobs. Every
pipeline decision is one metric and one structured log line with the same attributes, and each
log line written inside a trace carries its `trace_id`. Signals go out over OTLP to a collector
or straight to a vendor. A Prometheus endpoint covers installations without either, and the
built-in hourly statistics feed the UI, so the UI needs no external system.

## Try it locally

The Compose file has an optional `observability` profile. It runs
[`grafana/otel-lgtm`](https://github.com/grafana/docker-otel-lgtm), which is an OpenTelemetry
Collector, Prometheus, Loki, Tempo and Grafana in one container, with the Switchboard dashboard
provisioned:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/observability.env up -d
```

`deploy/observability.env` turns the profile on (`COMPOSE_PROFILES=observability`) and points
Switchboard at the collector (`OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4318`). Without the env
file, Compose starts Switchboard and Postgres only, and nothing is exported. Open Grafana at
http://localhost:3000 (anonymous admin, `LGTM_GRAFANA_PORT` changes the port) and pick
**Dashboards › AI Switchboard**. Then send an event
(`switchboard apply -f examples/log-destination.yaml` and the `curl` in the
[quick start](quick-start.md)). You get:

- **Metrics** in the dashboard panels (Prometheus, through the collector).
- **Logs** in the dashboard's _Logs_ panel, or in Explore › Loki with `{service_name="switchboard"}`.
  Open a line and follow its `trace_id` to the trace.
- **Traces** in the _Recent ingest traces_ panel, or through the dashboard's _Traces (Tempo)_
  link. A trace links back to its logs.

The profile is for trying Switchboard out: one container, anonymous Grafana, data in a volume.

## Configuration

Switchboard reads the standard
[OpenTelemetry SDK environment variables](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/).
[Configuration › Telemetry](configuration.md#telemetry) has the full table. In short:

| Variable                                                              | Default                        | Effect                                                                                  |
| --------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                         | —                              | OTLP base URL. Setting it exports all three signals. HTTP appends `/v1/<signal>`        |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT`                   | —                              | Per-signal URL, used as is                                                              |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                                         | `http/protobuf`                | `http/protobuf`, `http/json` or `grpc` (also per signal)                                |
| `OTEL_EXPORTER_OTLP_HEADERS`                                          | —                              | `key=value,...`, e.g. a vendor API key (also per signal). Never logged, never shown     |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_COMPRESSION`        | `10000`, `none`                | Export timeout (ms) and `gzip`                                                          |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` | `otlp` when an endpoint is set | `otlp`, `console`, `none`, or a list. Metrics also accept `prometheus`                  |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`                       | `switchboard`, —               | Resource. `service.version` and `service.instance.id` (the replica id) are always added |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`                      | `parentbased_always_on`        | e.g. `parentbased_traceidratio` with `0.1`                                              |
| `OTEL_METRIC_EXPORT_INTERVAL`                                         | `30000`                        | Metric push interval (ms)                                                               |
| `OTEL_SDK_DISABLED`                                                   | `false`                        | Turns OpenTelemetry off, `/metrics` included                                            |
| `SWITCHBOARD_PROMETHEUS`                                              | `true`                         | Serve Prometheus exposition at `GET /metrics`, with or without OTLP                     |
| `LOG_LEVEL`                                                           | `info`                         | Level of the logs, on stdout and exported alike                                         |

One deliberate difference from the spec is that nothing is exported until an endpoint is set.
The spec's default of `localhost:4318` would retry forever on installations without a collector.
You can set `OTEL_TRACES_EXPORTER=otlp` explicitly to use that default. An invalid value never
stops the server. It logs a `telemetry configuration` warning at start that names the variable,
and the default applies.

**Settings › About** shows what the replica serving the page exports: the exporters,
protocol and endpoint (`scheme://host:port`) of each signal, whether `/metrics` is served, the
service name and the sampler. Header values never appear there, and neither do header names. It
shows only how many headers are set. `GET /api/v1/about` returns the same as
`AboutResponse.telemetry`.

On Kubernetes, the Helm chart's `otel` values render these variables. `otel.headers` takes an
existing Secret key for `OTEL_EXPORTER_OTLP_HEADERS`. `deploy/helm/examples/otel-values.yaml` is
an example with a collector, resource attributes, a ratio sampler and a key in a Secret.

### Sending to a vendor

Each vendor accepts OTLP directly. A collector in between is still the better setup (see below).
Put API keys in a secret (Compose `.env`, a Kubernetes Secret), never in a committed file.

**Grafana Cloud** (stack › _OpenTelemetry_ › _Configure_ shows the values):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-2.grafana.net/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
# base64 of "<instance id>:<Grafana Cloud access policy token>", with the space percent-encoded
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20MTIzNDU2OmdsY19leUo...
```

**Honeycomb** (US; use `https://api.eu1.honeycomb.io` for EU). Metrics need a dataset:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<api key>
OTEL_EXPORTER_OTLP_METRICS_HEADERS=x-honeycomb-team=<api key>,x-honeycomb-dataset=switchboard-metrics
```

**New Relic** (US; use `https://otlp.eu01.nr-data.net` for EU). New Relic recommends delta
temporality for metrics:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net
OTEL_EXPORTER_OTLP_HEADERS=api-key=<ingest license key>
OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
```

**Datadog.** Send OTLP to the Datadog Agent, with its OTLP receiver enabled
(`DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=0.0.0.0:4318`), or to a collector with the
Datadog exporter. The API key then lives in the Agent or the collector:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://datadog-agent:4318
OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
```

Datadog also has agentless OTLP intake endpoints for some signals. Those take the key in a
`dd-api-key` header and have per-site URLs, so set them with the per-signal
`OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT` and `_HEADERS` variables, as Datadog's OTLP intake
documentation describes for your site.

### Through an OpenTelemetry Collector

With a collector, Switchboard needs only the endpoint. The collector holds the vendor keys and can
batch, retry, sample and fan out:

```yaml
# otel-collector.yaml
receivers:
  otlp:
    protocols:
      http: { endpoint: 0.0.0.0:4318 }
      grpc: { endpoint: 0.0.0.0:4317 }
processors:
  memory_limiter: { check_interval: 1s, limit_percentage: 80, spike_limit_percentage: 25 }
  batch: {}
  # On Kubernetes, add pod, namespace and deployment attributes:
  # k8sattributes: {}
exporters:
  otlphttp/vendor:
    endpoint: https://otlp.example-vendor.com
    headers: { api-key: '${env:VENDOR_API_KEY}' }
service:
  pipelines:
    traces: { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlphttp/vendor] }
    metrics:
      { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlphttp/vendor] }
    logs: { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlphttp/vendor] }
```

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

### Prometheus

`GET /metrics` serves the same metrics in Prometheus exposition format (`SWITCHBOARD_PROMETHEUS`,
default on), next to OTLP or without it:

```yaml
scrape_configs:
  - job_name: switchboard
    metrics_path: /metrics
    static_configs:
      - targets: ['switchboard:8080']
```

On Kubernetes, set `serviceMonitor.enabled=true` in the Helm chart when the Prometheus Operator
is installed. Do not both scrape `/metrics` and push OTLP metrics into the same Prometheus. That
stores every series twice. Pick one per backend.

## Traces

A trace starts at the HTTP request that delivered an event. If the sender passed a W3C
`traceparent`, the trace continues the sender's own. It follows the event through every queue
job, on whichever replica runs it, to the terminal run and its after steps. The shape for one
event that becomes one run:

```text
POST /hooks/:sourceId                 SERVER  http.route, http.response.status_code, client.address
└─ switchboard.ingest                 source_id, event_ids, switchboard.events.count
   ├─ switchboard.plugin.verify       plugin, instance_id, switchboard.plugin.method
   ├─ switchboard.plugin.parse
   └─ process pipeline.match          CONSUMER  messaging.destination.name, event_id
      └─ switchboard.match            event_id
         └─ process pipeline.fire     (when the batch waits for its debounce)
            └─ switchboard.batch      batch_id
               └─ process pipeline.dispatch
                  └─ switchboard.dispatch        batch_id, process_id, run_id, switchboard.outcome
                     │                           links → the ingest span of every event in the batch
                     ├─ switchboard.gate         switchboard.gate.pass, switchboard.gate.reason
                     ├─ switchboard.budget       switchboard.budget.outcome, switchboard.budget.binding
                     └─ switchboard.invoke       run_id, plugin, switchboard.invoke.attempt, .action
                        ├─ switchboard.steps     (before steps) switchboard.plugin.act …
                        ├─ switchboard.plugin.invoke
                        │  └─ POST               CLIENT  the destination's HTTP call; the backend
                        │                        receives traceparent naming this span
                        ├─ process pipeline.poll → switchboard.track   (tracking: poll)
                        └─ process pipeline.finish
                           ├─ switchboard.steps  (after steps)
                           └─ switchboard.notify → switchboard.plugin.send
```

- **Across the queue.** A job carries the W3C `traceparent` of the span that sent it, beside
  its ids. The handler runs in a `process <job>` CONSUMER span whose parent is that
  `traceparent`, so a trace holds together across replicas and across delays: debounce, retry
  back-off, poll intervals.
- **Batches.** Many events can join one batch. The batch continues the trace of the event that
  opened it, and `switchboard.dispatch` has a **span link** to the ingest span of each of its
  events (`events.trace_context`). From any event's trace you can reach the run that took it, and
  from the run you can reach every event.
- **Runs.** A run stores the trace context of its dispatch (`runs.trace_context`). Recovery
  continues that trace when it re-invokes or resumes polling. A callback
  (`POST /callbacks/:destinationId`) gets its own trace, from the backend's `traceparent` if it
  sent one, and its `switchboard.track` span **links** to the run's trace.
- **Plugin calls.** Every method call on a plugin instance inside a trace gets a
  `switchboard.plugin.<method>` span, such as `verify`, `parse`, `invoke`, `poll`,
  `readMeters`, `act`, `send`, `resolve` or `verifyCallback`. A throw marks the span failed.
  Calls outside a trace, like health checks, get no span.
- **Outbound HTTP.** The plugin `HttpClient` makes each request a CLIENT span and sends
  `traceparent` and `tracestate` from the active context, so an instrumented backend continues
  the trace. The span records the URL without its query string, which may carry a token.
- **Schedules and periodic work.** A sweep's dispatch, a pull source's poll (`source.poll`) and a
  meter read (`meters.read`) start their own traces. Housekeeping jobs (scheduler tick,
  maintenance, statistics, retention) start none.
- **HTTP.** `/api/*`, `/hooks/*` and `/callbacks/*` get SERVER spans named after the route
  template. Probes (`/healthz`, `/readyz`), `/metrics` and the UI's static files do not.

Sampling follows `OTEL_TRACES_SAMPLER`. The default `parentbased_always_on` keeps every trace
and honours a sender's decision. The sampled flag travels with the stored `traceparent`, so a
trace is kept or dropped as a whole across jobs.

## Logs

Logs are pino JSON lines on stdout, unchanged. When logs are exported (an OTLP endpoint, or
`OTEL_LOGS_EXPORTER`), every line is also emitted as an OpenTelemetry log record:

| pino              | OTel log record                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `level`           | `severityNumber` / `severityText` (`trace` 1, `debug` 5, `info` 9, `warn` 13, …)                                                            |
| `msg`             | `body`                                                                                                                                      |
| `time`            | `timestamp`                                                                                                                                 |
| `err`             | `exception.type`, `exception.message`, `exception.stacktrace`                                                                               |
| every other field | an attribute: `component`, `plugin`, `instance_id`, `event_id`, `process_id`, `batch_id`, `run_id`, `external_url`, the decision attributes |
| the active span   | the record's trace and span ids                                                                                                             |

The bridge receives each line after pino has redacted it, so redaction applies before export.
Plugin loggers (`ctx.logger`) are children of the core logger and flow through the same way,
with `plugin` and `instance_id`. Two kinds of lines are never exported. The OpenTelemetry
SDK's own diagnostics (`component: otel`, level `OTEL_LOG_LEVEL`) stay out, so a failing
exporter cannot feed itself. The one-time bootstrap admin password line stays out too, and
appears on stdout only.

Decision lines (`signal: switchboard.events`, `switchboard.runs`, …) carry the metric's
attributes plus `event_id`, `process_id`, `batch_id`, `run_id` and `external_url` wherever they
exist. A search for a run id returns the run's whole story. Secret values never appear in logs.

### Correlation

Every line logged inside a span, including Fastify's `request completed`, gets `trace_id`
and `span_id`. You can see them in `docker compose logs` too, and the exported record carries
them as its trace context. In Grafana, a Loki line links to its Tempo trace and a trace links back
to its logs (the `otel-lgtm` data sources are provisioned that way). For your own Grafana, set a
Loki derived field on `trace_id` and Tempo's _trace to logs_.

## Metrics

One metric and one structured log line per pipeline decision, with the same attributes on both.
Prometheus names follow the OpenTelemetry conversion. That holds for both `/metrics` and OTLP
into Prometheus: dots become underscores, counters get `_total`, and the second-based histograms
get `_seconds` with `_bucket`, `_sum` and `_count`.

| Signal                           | Prometheus name                               | Kind      | Attributes                                                                                   | Meaning                                                                                                                                           |
| -------------------------------- | --------------------------------------------- | --------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `switchboard.events`             | `switchboard_events_total`                    | counter   | `source`, `type`, `stage`                                                                    | Events received, per outcome at the door                                                                                                          |
| `switchboard.dispatches`         | `switchboard_dispatches_total`                | counter   | `process`, `source`, `outcome`                                                               | Match and dedupe results                                                                                                                          |
| `switchboard.batches`            | `switchboard_batches_total`                   | counter   | `process`, `kind`, `outcome`, `reason`                                                       | Gate and budget results (held, throttled, invoked)                                                                                                |
| `switchboard.runs`               | `switchboard_runs_total`                      | counter   | `process`, `destination`, `status`                                                           | Run terminal states                                                                                                                               |
| `switchboard.run.latency`        | `switchboard_run_latency_seconds_bucket`      | histogram | `process`                                                                                    | Event `occurredAt` → invoke                                                                                                                       |
| `switchboard.run.duration`       | `switchboard_run_duration_seconds_bucket`     | histogram | `process`, `destination`                                                                     | Invoke → terminal                                                                                                                                 |
| `switchboard.run.usage`          | `switchboard_run_usage_total`                 | counter   | `process`, `destination`, `unit`                                                             | Usage per declared dimension, as the destination plugin reported it                                                                               |
| `switchboard.schedule.lag`       | `switchboard_schedule_lag_seconds_bucket`     | histogram | `process`                                                                                    | Cron tick → sweep invoke                                                                                                                          |
| `switchboard.meter.utilization`  | `switchboard_meter_utilization`               | gauge     | `destination`, `meter`, `estimated`                                                          | Latest reading, 0–100                                                                                                                             |
| `switchboard.meter.resets_in`    | `switchboard_meter_resets_in`                 | gauge     | `destination`, `meter`                                                                       | Seconds until the meter resets                                                                                                                    |
| `switchboard.budget.used`        | `switchboard_budget_used`                     | gauge     | `scope`, `window`                                                                            | Counter versus cap                                                                                                                                |
| `switchboard.breaker`            | `switchboard_breaker`                         | gauge     | `process`                                                                                    | 1 while open                                                                                                                                      |
| `switchboard.source.health`      | `switchboard_source_health`                   | gauge     | `source` (instance id)                                                                       | 1 healthy                                                                                                                                         |
| `switchboard.destination.health` | `switchboard_destination_health`              | gauge     | `destination` (instance id)                                                                  | 1 healthy                                                                                                                                         |
| `switchboard.plugin.errors`      | `switchboard_plugin_errors_total`             | counter   | `plugin`, `kind`                                                                             | Exceptions and invalid events attributed to a plugin                                                                                              |
| `switchboard.instance.rebuilds`  | `switchboard_instance_rebuilds_total`         | counter   | `kind`, `change`                                                                             | Instances a replica's reconcile pass built (`created`), rebuilt (`changed`, `dependent`) or dropped (`removed`) after a change on another replica |
| `switchboard.heartbeat`          | `switchboard_heartbeat_total`                 | counter   | `replica`                                                                                    | Emitted every 30 s by each live replica                                                                                                           |
| `http.server.request.duration`   | `http_server_request_duration_seconds_bucket` | histogram | `http.request.method`, `http.route`, `http.response.status_code`, `url.scheme`, `error.type` | API, `/hooks` and `/callbacks` requests (OpenTelemetry HTTP semantic conventions)                                                                 |

Attribute values are the outcome vocabulary from [concepts](concepts.md#outcome-vocabulary):
event stages, dispatch outcomes, batch outcomes with hold reasons, run statuses.

Histogram buckets are in seconds. `switchboard.run.latency` and `switchboard.run.duration` use
0.5 s to 24 h (0.5, 1, 2.5, 5, 10, 30 s, 1, 2, 5, 10, 15, 30 min, 1, 2, 6, 24 h), because
latency includes debounce and approvals and a run can track for hours.
`switchboard.schedule.lag` uses 0.1 s to 1 h. `http.server.request.duration` uses the
semantic-convention buckets, 5 ms to 10 s.

Over OTLP, the resource carries `service.name`, `service.version`, `service.instance.id` (the
replica id) and your `OTEL_RESOURCE_ATTRIBUTES`. Prometheus's OTLP receiver maps them to
`job`, `instance` and `target_info`.

## Overhead

- **Nothing configured.** No exporter runs. The tracer provider is registered with an always-off
  sampler, so spans are not recorded but still carry ids. Log lines get `trace_id`, and a
  sender's `traceparent` reaches plugin HTTP calls. The log bridge is not attached.
- **Traces.** About 15 short spans per event that becomes a run, plus one per poll. Spans are
  batched in memory and exported in the background (SDK defaults: 2048 queued, 512 per batch,
  every 5 s, `OTEL_BSP_*`). When the queue is full, spans are dropped, never waited on.
- **Logs.** Only when exported: each line is parsed once more (JSON) and queued for a batch
  export (`OTEL_BLRP_*`). stdout is unaffected.
- **Metrics.** Aggregated in memory and pushed every `OTEL_METRIC_EXPORT_INTERVAL`. Attributes
  are ids from the configuration, so cardinality grows with the number of processes, sources
  and destinations, not with the number of events.
- **Queue jobs** carry one extra 55-byte field (`traceparent`), and `events` and `runs` rows one
  nullable column each.

## Built-in statistics

Every chart in the UI (events by source and type, funnel counts per process, runs by status,
latency and duration percentiles, meter history, budget history) comes from an hourly
materialisation in Postgres (`stats_hourly`), kept for two years by default. Nothing in the UI
queries an external observability system.

## Grafana dashboard

`deploy/grafana/switchboard-dashboard.json` is a starting point. It works over the Prometheus
metrics, whether scraped from `/metrics` or pushed over OTLP, since the names are the same. It
shows events by source and stage, dispatch outcomes, batches held and throttled by reason, runs
by status, latency and duration p50/p95, meter utilization per destination and meter, budget
usage, open breakers, plugin errors, replica heartbeats and HTTP p95 and status by route. With
Loki and Tempo data sources, it also shows the logs and the recent ingest traces.

The Compose `observability` profile provisions it. To import it elsewhere: Grafana →
**Dashboards → New → Import** → upload the JSON → pick your Prometheus data source, plus Loki and
Tempo for the logs and traces panels (their variables can stay empty without them). Use the
dashboard's template variables to narrow it to one process, destination or source, and
`service` if you changed `OTEL_SERVICE_NAME`.

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

      - alert: SwitchboardHookErrors
        expr: sum(rate(http_server_request_duration_seconds_count{http_route="/hooks/:sourceId", http_response_status_code=~"5.."}[10m])) > 0
        for: 10m
        annotations:
          summary: 'Webhook deliveries are answered with 5xx (senders will retry)'
```
