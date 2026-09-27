# @ai-switchboard/source-datadog

Datadog monitor notifications as a source (type id `datadog`, mode `push`), through Datadog's
Webhooks integration, plus live monitor state (`resolve`). Calls only the API host of the configured
site (`api.datadoghq.com`, `api.datadoghq.eu`, `api.us3.datadoghq.com`, `api.us5.datadoghq.com`,
`api.ap1.datadoghq.com`).

## Settings

| Field          | Group          | Default                | Description                                                         |
| -------------- | -------------- | ---------------------- | ------------------------------------------------------------------- |
| `headerName`   | Webhook        | `x-switchboard-secret` | Custom header carrying the shared secret.                           |
| `sharedSecret` | Webhook        | —                      | **Secret.** At least 16 characters; also pasted into Datadog.       |
| `site`         | API (optional) | `datadoghq.com`        | `datadoghq.com`, `datadoghq.eu`, `us3.`/`us5.`/`ap1.datadoghq.com`. |
| `apiKey`       | API (optional) | —                      | **Secret.** For `resolve` and `health`.                             |
| `appKey`       | API (optional) | —                      | **Secret.** For `resolve`.                                          |

## Verification

Datadog webhooks can't sign bodies, so the source checks a shared-secret custom header
(`headerName`) against `sharedSecret` with a constant-time comparison. A missing or wrong header is
rejected before `parse`.

## Webhook payload template

In Datadog → Integrations → Webhooks → New, set:

- **URL:** `https://<switchboard>/hooks/<instanceId>`
- **Custom headers:** `{ "x-switchboard-secret": "<sharedSecret>" }`
- **Payload** (paste exactly; the keys are what the source reads):

```json
{
  "id": "$ID",
  "alertId": "$ALERT_ID",
  "alertCycleKey": "$ALERT_CYCLE_KEY",
  "transition": "$ALERT_TRANSITION",
  "alertType": "$ALERT_TYPE",
  "alertStatus": "$ALERT_STATUS",
  "priority": "$PRIORITY",
  "title": "$ALERT_TITLE",
  "tags": "$TAGS",
  "link": "$LINK",
  "date": "$DATE",
  "lastUpdated": "$LAST_UPDATED",
  "orgId": "$ORG_ID",
  "hostname": "$HOSTNAME",
  "metric": "$ALERT_METRIC",
  "scope": "$ALERT_SCOPE",
  "eventType": "$EVENT_TYPE"
}
```

Then add `@webhook-<name>` to the monitors' messages. A variable Datadog leaves unsubstituted
(`"$HOSTNAME"` on a monitor without hosts) or empty is treated as absent.

**Timeouts and retries.** Datadog waits at most 15 s for an answer and retries only on a 5xx. The
core stores the delivery and answers before any processing runs, so a slow pipeline never causes a
timeout, and a 5xx (Postgres down) makes Datadog retry — the dedupe key collapses those retries.

## Event types

From `$ALERT_TRANSITION`:

| Event type                  | Transition values                                           |
| --------------------------- | ----------------------------------------------------------- |
| `datadog.monitor.triggered` | `Triggered` — **and any value not listed here** (see below) |
| `datadog.monitor.recovered` | `Recovered` (and variants such as `Warn Recovered`)         |
| `datadog.monitor.warn`      | `Warn`                                                      |
| `datadog.monitor.no_data`   | `No Data`                                                   |
| `datadog.monitor.renotify`  | `Re-Triggered`, `Re-Warn`, `Re-No Data`, `Renotify`         |

An unrecognised transition maps to `triggered` rather than being dropped, so a new Datadog value
still reaches processes; `transition` keeps the raw value, and a filter such as
`transition = 'Triggered'` excludes it if you need strictness.

Artifact: `{ kind: 'datadog.monitor', id: $ALERT_ID, url: $LINK }` with **no version** (monitors
have none). The delivery id is `$ALERT_CYCLE_KEY` (falling back to `$ID`), so the dedupe key
collapses redeliveries — and repeated re-notifications — within one alert cycle, while the next
cycle yields a new key. `occurredAt` comes from `$DATE` (epoch ms), then `$LAST_UPDATED`, then the
receipt time.

Attributes (flat): `monitorId`, `title`, `transition`, `alertType`, `priority`, `tags` (string[]
from the comma-separated `$TAGS`), `hostname`, `metric`, `scope`, `orgId`. The notification message
body is never an attribute.

## resolve and health

- `resolve({ kind: 'datadog.monitor', id })` → `GET /api/v1/monitor/{id}` →
  `{ ref, name, overallState, tags, priority ('P1'…), url }`; `null` on 404. Needs `apiKey` and
  `appKey`.
- `health()` → `GET /api/v1/validate` when `apiKey` is set; `unknown` otherwise.

There are no actions.

## Credential scopes

API key: any org API key. Application key: scope it to `monitors_read`. Neither is needed just to
receive alerts.
