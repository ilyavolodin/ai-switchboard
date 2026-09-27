# @ai-switchboard/executor-http

The universal executor (type `http`). Each run sends one HTTP request to any endpoint: an
internal job runner, a serverless function, any webhook-triggered automation. The process picks
per target whether the response _is_ the result (`sync`), whether the endpoint posts back later
(`callback`), or whether a 2xx is all there is (`none`).

Because a process can name any URL, this plugin declares `capabilities.network: ["*"]`. That is
deliberate: it is the universal executor. Pin credentials with a base URL (below) and let
operators know every target URL is reachable.

## Instance settings

| Field             | Group     | Secret          | Description                                                                                                                          |
| ----------------- | --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`         | Endpoint  |                 | Relative target URLs are appended to it. When set, the default headers are sent **only** to this origin, and `health()` requests it. |
| `headers`         | Endpoint  | `authorization` | Default headers. `headers.authorization` is a secret (e.g. `Bearer …`); other keys are plain headers.                                |
| `callbackSecret`  | Callbacks | yes             | Shared secret for signed callbacks (at least 16 characters). Needed by targets with `callback` tracking.                             |
| `usageDimensions` | Usage     |                 | Dimensions this instance reports. Default: `duration_seconds` (seconds, sum, budgetable) and `response_bytes` (bytes, sum).          |
| `meterEndpoint`   | Meters    |                 | Optional URL (absolute or relative to the base URL) answering GET with `{ "used": n, "limit": n, "resetsAt": "<ISO>" }`.             |
| `meterUnit`       | Meters    |                 | Unit of that meter (default `requests`).                                                                                             |

Without a `baseUrl`, the default headers (including the authorization secret) go to every URL a
target names. Set a base URL whenever the instance carries a credential.

## Target

```json
{
  "method": "POST",
  "url": "/jobs/triage",
  "headers": { "x-queue": "low" },
  "tracking": "sync",
  "idempotent": false,
  "usageFrom": "{ \"cost_usd\": response.body.cost }",
  "timeoutSeconds": 60
}
```

- `method`: `GET`, `POST` (default), `PUT`, `PATCH`, `DELETE`. `GET` and `DELETE` send no body.
- `url`: absolute, or a path appended to the base URL.
- `tracking`: `sync` (default), `callback` or `none`.
- `idempotent`: tick only if the endpoint deduplicates on `x-switchboard-run-id`; the core then
  retries a request whose response was lost. Default false: a lost response leaves the run
  `uncertain` and the core never sends it twice.
- `usageFrom` (sync only): a JSONata expression over
  `{ response: { status, headers, body }, durationSeconds }` returning `{ dimensionId: number }`.
  Keys that are not declared dimensions are dropped. A failing expression is logged and ignored;
  it never fails a run whose work already happened.

## Input

Any JSON value, sent as the body with `content-type: application/json`.

## Request

Every request carries:

- `x-switchboard-run-id`: the core run id (deduplicate on it if you declare `idempotent`).
- `x-switchboard-callback-url`: where to POST the callback.
- `x-switchboard-dry-run: 1`: only on test runs with the dry-run flag. Simulate if you can.

## Outcomes

| Response                 | Result                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2xx, `sync`              | `completed`; `result` is the JSON body (or the text when it is not JSON); usage is `duration_seconds`, `response_bytes` and the `usageFrom` output |
| 2xx, `callback` / `none` | `started`; `externalId` from the body's `id`, `requestId` or `request_id` when present. The core closes `none` runs as `ok`                        |
| 423 Locked               | `held` with reason `paused`: answer 423 when the target is paused on your side                                                                     |
| 429                      | `failed` with `retryAfterSeconds` from `Retry-After` (60 s when absent); opens a soft-hold on the instance                                         |
| 503                      | `InvokeError` status 503: the core retries                                                                                                         |
| other 4xx                | `InvokeError`, definitive: the run is `failed`                                                                                                     |
| other 5xx                | `InvokeError`, not definitive: the run becomes `uncertain` unless the target is idempotent                                                         |
| network failure          | `TransportError` from the SDK client; `sent: false` is retried, `sent: true` is `uncertain`                                                        |

429 is always _returned_ (never thrown) by the reference executors, so the soft-hold and the
run outcome travel together.

## Callbacks

For `callback` targets, the endpoint POSTs to `x-switchboard-callback-url` when the work ends:

```json
{
  "runId": "<x-switchboard-run-id>",
  "status": "ok",
  "outputs": 1,
  "errors": [],
  "usage": { "duration_seconds": 42 },
  "finishedAt": "2026-09-27T10:05:00Z"
}
```

signed with `x-switchboard-signature: sha256=<hex HMAC-SHA256 of the raw body with callbackSecret>`.
Unsigned, wrongly signed or malformed callbacks are rejected. Unknown top-level fields are
ignored; usage keys that are not declared dimensions are dropped.

```bash
body='{"runId":"'"$RUN_ID"'","status":"ok","usage":{"duration_seconds":42}}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$CALLBACK_SECRET" | sed 's/^.* //')
curl -sS -X POST "$CALLBACK_URL" -H 'content-type: application/json' \
  -H "x-switchboard-signature: sha256=$sig" --data "$body"
```

## Usage and meters

- Usage: whatever the instance declares in `usageDimensions`. The executor measures
  `duration_seconds` and `response_bytes` for sync runs; anything else comes from `usageFrom` or
  from the callback. The executor never estimates.
- Meters: none by default. With `meterEndpoint`, a `window` meter `endpoint` (primary) whose
  utilization is `used / limit`. The request carries the default headers when the endpoint is on
  the base URL origin.

## Health

`unknown` without a base URL. Otherwise `HEAD` (falling back to `GET` on 405) on the base URL:
401/403 and 5xx are `unhealthy`, anything else `healthy`.

## Credentials

Whatever the endpoint needs, in `headers.authorization`. Give it the narrowest token that can
start the work.
