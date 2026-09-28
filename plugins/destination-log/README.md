# @ai-switchboard/destination-log

A test destination. It writes every invocation to the Switchboard server log, answers with the
input it received, and can simulate every outcome the pipeline handles — so you can wire a
source to a process and watch runs, breakers, soft-holds and meters without a real backend.

Baked into the image. Type id: `log`. Tracking: `sync`. Idempotent (logging twice is harmless).
No network access.

## Instance settings

| Setting          | Default | Meaning                                                                                                                                                       |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `level`          | `info`  | Log level of the invocation line (`debug`, `info`, `warn`).                                                                                                   |
| `logInput`       | `true`  | Include the mapped input in the log line.                                                                                                                     |
| `maxLoggedBytes` | `4096`  | Truncate the logged input beyond this size (the run keeps it whole).                                                                                          |
| `hourlyLimit`    | —       | Optional. Adds an **Hourly runs** meter: invocations in the last hour against this limit. Set a low limit and a meter ceiling on a process to see throttling. |

## Target (per process)

| Field               | Default | Meaning                                                                                                                                                                                              |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`             | —       | A word to find the process's lines in the log.                                                                                                                                                       |
| `outcome`           | `ok`    | `ok` succeeds · `error` backend error (counts toward the breaker) · `failed` definitive refusal · `held` target paused · `rate_limited` out of capacity (opens a soft-hold for `retryAfterSeconds`). |
| `delayMs`           | `0`     | Wait before answering (≤ 30 s), to see a run in flight.                                                                                                                                              |
| `retryAfterSeconds` | `60`    | Soft-hold length for `rate_limited`.                                                                                                                                                                 |

Input: anything; it is echoed back as the run's result.

## Usage and meters

Usage per run: `invocations` (count) and `input_bytes` (bytes), both budgetable.
Meter: `hourly_runs` (window, %) when `hourlyLimit` is set; dry runs are not counted.

## Action

`log { message }` — use it as a before/after step to see steps run.

## Log line

```json
{
  "level": "info",
  "plugin": "@ai-switchboard/destination-log",
  "msg": "log destination invocation",
  "run_id": "…",
  "process": "Alert to stub",
  "mode": "event",
  "label": "demo",
  "outcome": "ok",
  "input": "{…}"
}
```

Watch it with `docker compose -f deploy/docker-compose.yml logs -f switchboard | grep "log destination"`.
