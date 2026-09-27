# @ai-switchboard/executor-claude-routines

Executor type `claude-routines`: fires a [Claude Code routine](https://docs.claude.com/en/docs/claude-code)
through its API trigger. The routine's completion step posts a signed callback with the outcome
and token usage, which closes the run.

- **Tracking:** `callback`. The Routines API has no run listing, so there is nothing to poll; a
  run without a callback becomes `unknown` at the process's tracking deadline.
- **Idempotent:** no. A lost fire response leaves the run `uncertain`; it is never fired twice.
- **Network:** `api.anthropic.com`, `console.anthropic.com`.

## Instance settings

| Field                     | Group           | Secret | Default                                        | Description                                                                                    |
| ------------------------- | --------------- | ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apiBaseUrl`              | Routine trigger |        | `https://api.anthropic.com`                    | Anthropic API origin                                                                           |
| `token`                   | Routine trigger | yes    |                                                | The routine's API trigger bearer token                                                         |
| `betaHeader`              | Routine trigger |        | `experimental-cc-routine-2026-04-01`           | Sent as `anthropic-beta`. The trigger API is a dated beta; change this when Anthropic moves it |
| `callbackSecret`          | Callbacks       | yes    |                                                | Shared secret (≥ 16 chars) the completion step signs the callback with                         |
| `usage.oauthRefreshToken` | Meters          | yes    |                                                | The seat's Claude OAuth refresh token. Optional: without it, only estimated meters exist       |
| `usage.oauthClientId`     | Meters          |        | Claude Code's public client id                 | Client the refresh token was issued to                                                         |
| `usage.oauthTokenUrl`     | Meters          |        | `https://console.anthropic.com/v1/oauth/token` | Token endpoint                                                                                 |
| `usage.usageUrl`          | Meters          |        | `https://api.anthropic.com/api/oauth/usage`    | Seat usage endpoint                                                                            |
| `usage.dailyRunLimit`     | Meters          |        | `15`                                           | Your plan's daily routine runs, for the estimated `daily_runs` meter                           |

## Target and input

```json
{ "routineId": "trig_01ABCDEF" }
```

```json
{ "text": "mode: event\nrepository: acme/api\nissue: 42" }
```

`invoke` is `POST {apiBaseUrl}/v1/claude_code/routines/{routineId}/fire` with
`authorization: Bearer <token>`, `anthropic-version: 2023-06-01`, `anthropic-beta: <betaHeader>`
and body `{ "text": ... }`. The executor appends a delimited trailer to the text:

```
mode: event
repository: acme/api
issue: 42

--- switchboard ---
switchboard_run_id: 6f1c…
switchboard_callback_url: https://switchboard.example.com/callbacks/<instance>
--- end switchboard ---
```

On test runs with the dry-run flag the trailer also carries `switchboard_dry_run: true`. The
routine is still fired (the API cannot simulate); the routine's prompt decides what a dry run
means (for example: plan, don't push).

The response's session id and URL become the run's external id and link. Accepted shapes:
`{ id, session_url }`, `{ claude_code_session_id, claude_code_session_url }`, or a nested
`session` object.

### The text is untrusted data

Whatever the input mapping produces arrives to the routine as **untrusted data**: event titles,
comments and labels can be written by anyone who can touch the source system. The routine's
prompt must opt in to acting on it, and should treat it as a pointer to real state, not as
instructions. The recommended mapping is references plus a mode (`repository`, `issue`, `mode`)
so the routine re-reads the real issue with its own tools. Only the trailer between
`--- switchboard ---` and `--- end switchboard ---` at the very end of the text is written by
Switchboard.

## Outcomes

| Fire response                 | Result                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 2xx                           | `started` with the session id and URL                                                                      |
| 429                           | `failed` with `retryAfterSeconds` from `Retry-After` (60 s when absent); opens a soft-hold on the instance |
| 400/409 mentioning "paused"   | `held`, reason `paused`                                                                                    |
| 400/409 mentioning "disabled" | `held`, reason `disabled`                                                                                  |
| 401, 403, 404, other 4xx      | definitive `InvokeError`: the run is `failed` (and a 401/403 marks the instance unhealthy in the core)     |
| 503, 529 (overloaded)         | `InvokeError` status 503: the core retries                                                                 |
| other 5xx                     | `InvokeError`, not definitive: the run is `uncertain`                                                      |
| network failure               | the SDK's `TransportError`: retried only when nothing was sent                                             |

## The completion step

End the routine's prompt with a step that posts the outcome to `switchboard_callback_url`,
signed with the callback secret. Store the secret in the routine's environment (for example
`SWITCHBOARD_CALLBACK_SECRET`), never in the prompt.

Body:

```json
{
  "runId": "<switchboard_run_id from the trailer>",
  "status": "ok",
  "sessionUrl": "https://claude.ai/code/session_…",
  "errors": [],
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 800,
    "cache_read_tokens": 50000,
    "cache_write_tokens": 4000,
    "duration_seconds": 312
  }
}
```

`status` is `ok` or `error`; `errors` lists what went wrong. `usage` is summed from the session
transcript; leave out what you can't measure (the core never estimates per-run usage). Unknown
fields are ignored, and so are unknown usage keys.

Example step (a shell command the routine runs):

```bash
body=$(jq -nc --arg run "$SWITCHBOARD_RUN_ID" --arg url "$SESSION_URL" \
  --argjson usage "$USAGE_JSON" \
  '{runId: $run, status: "ok", sessionUrl: $url, usage: $usage}')
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SWITCHBOARD_CALLBACK_SECRET" | sed 's/^.* //')
curl -sS -X POST "$SWITCHBOARD_CALLBACK_URL" \
  -H 'content-type: application/json' \
  -H "x-switchboard-signature: sha256=$sig" \
  --data "$body"
```

The signature is the hex HMAC-SHA256 of the exact bytes sent, prefixed `sha256=`. Unsigned,
wrongly signed or malformed callbacks are rejected without a body.

## Usage dimensions

| Id                   | Unit    | Aggregate | Budgetable |
| -------------------- | ------- | --------- | ---------- |
| `input_tokens`       | tokens  | sum       | yes        |
| `output_tokens`      | tokens  | sum       | yes        |
| `cache_read_tokens`  | tokens  | sum       | yes        |
| `cache_write_tokens` | tokens  | sum       | yes        |
| `duration_seconds`   | seconds | sum       | yes        |

All come from the callback.

## Meters

| Id                    | Kind            | Source                                                                    |
| --------------------- | --------------- | ------------------------------------------------------------------------- |
| `five_hour` (primary) | window, %       | seat usage endpoint                                                       |
| `seven_day`           | window, %       | seat usage endpoint                                                       |
| `daily_runs`          | allowance, runs | **estimated** by the core from its own run counts against `dailyRunLimit` |

To read the windows, the executor exchanges the refresh token at the token endpoint and GETs
the usage URL with `anthropic-beta: oauth-2025-04-20`, expecting
`{ five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at } }`.

- **The usage endpoint is undocumented.** It is the one Claude Code's `/usage` command reads. If
  Anthropic changes or removes it, `readMeters` fails, the core shows the windows as stale, and
  ceilings fall back to the estimated meter and the run counters. Nothing else breaks.
- The token endpoint rotates the refresh token on every refresh. The newest refresh token and
  the access token with its expiry are kept in the instance state and preferred over the
  settings on later reads. Pasting a new token into the settings restarts the chain. Give this
  instance its **own** login: a Claude Code CLI sharing the same refresh token would rotate it
  away from the instance (and vice versa).
- Without `usage.oauthRefreshToken`, `readMeters` returns nothing and all three meters are
  unavailable or estimated.

To get a refresh token, sign in to Claude Code with the seat on a spare machine and copy
`claudeAiOauth.refreshToken` from `~/.claude/.credentials.json` (on macOS, the "Claude
Code-credentials" keychain item), then sign that machine out without revoking.

## Health

`unknown`: the Routines API has no read-only call that checks a trigger token. A 401/403 on the
first fire marks the instance unhealthy.

## Credentials

- The routine's API trigger token: it can only fire that routine.
- The seat's OAuth refresh token (optional): read access to the seat's usage.
- A random callback secret: `openssl rand -hex 32`.
