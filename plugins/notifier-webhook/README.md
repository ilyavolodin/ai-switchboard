# @ai-switchboard/notifier-webhook

Notifier type `webhook`: POSTs each notification as JSON to any URL, optionally HMAC-signed.

Type ids are unique per kind, so this notifier is `webhook` like the webhook _source_; the two
never meet. **Network:** `*` (the receiving URL is whatever the admin configures).

## Settings

| Field     | Group    | Secret | Description                               |
| --------- | -------- | ------ | ----------------------------------------- |
| `url`     | Delivery |        | Receives the POST                         |
| `secret`  | Delivery | yes    | Optional (≥ 16 chars). Signs the raw body |
| `headers` | Delivery |        | Extra plain headers (not secret)          |

## Request

```http
POST <url>
content-type: application/json
user-agent: ai-switchboard
x-switchboard-signature: sha256=<hex HMAC-SHA256 of the raw body>   (when a secret is set)

{
  "on": "error",
  "severity": "error",
  "title": "Triage run failed",
  "text": "Run for acme/api#42 ended in error",
  "url": "https://switchboard.example.com/runs/…",
  "fields": { "Process": "Triage" }
}
```

The body is the `NotificationMessage` exactly (`on`: `ok` | `error` | `held` | `throttled` |
`system`; `severity`: `info` | `warning` | `error`; `url` and `fields` optional). Configured
headers cannot override `content-type` or the signature.

Verify on the receiver by recomputing the HMAC over the raw bytes and comparing in constant
time, e.g. `openssl dgst -sha256 -hmac "$SECRET"`.

## Errors and health

`send` throws on any non-2xx response and on network failures. `health()` is `unknown`: a
webhook cannot be checked without sending a notification.
