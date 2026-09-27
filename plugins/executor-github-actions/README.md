# @ai-switchboard/executor-github-actions

Executor type `github-actions`: dispatches a `workflow_dispatch` workflow and polls its run.

- **Tracking:** `poll` (workflow runs API), correlated by a `switchboard_run_id` input.
- **Idempotent:** no. A lost dispatch response leaves the run `uncertain`; it is never
  dispatched twice.
- **Network:** `api.github.com` (GitHub Enterprise Server is not supported by this version).

## Instance settings

| Field            | Group          | Secret | Description                                                             |
| ---------------- | -------------- | ------ | ----------------------------------------------------------------------- |
| `auth`           | Authentication |        | `app` (default, recommended) or `token`                                 |
| `appId`          | GitHub App     |        | The App's App ID (or Client ID)                                         |
| `privateKey`     | GitHub App     | yes    | The App's PEM private key. Literal `\n` sequences are accepted          |
| `installationId` | GitHub App     |        | The App's installation on the org or account that owns the repositories |
| `token`          | Token          | yes    | A fine-grained personal access token, for `auth: token`                 |

With `app`, the executor signs an RS256 JWT with the private key (`node:crypto`, no extra
dependency), exchanges it for an installation token, and keeps the token in memory until five
minutes before it expires.

### Permissions

GitHub App (or fine-grained PAT), on the repositories the processes target:

- **Actions: read and write** (dispatch, read runs, timing and jobs)
- **Contents: read** (required by the dispatch endpoint)
- **Metadata: read** (always granted)

## Target and input

```json
{ "owner": "acme", "repo": "api", "workflow": "triage.yml", "ref": "main" }
```

- `workflow`: file name or numeric workflow id. `ref` defaults to `main`.

Input: the workflow's `workflow_dispatch` inputs, all strings:

```json
{ "issue": "42", "mode": "event" }
```

The executor adds `switchboard_run_id` (overwriting any input of that name). **The workflow
must declare it and put it in the run name**, or GitHub rejects the dispatch (422, unexpected
input) and correlation cannot work:

```yaml
on:
  workflow_dispatch:
    inputs:
      issue: { type: string, required: true }
      mode: { type: string, default: event }
      switchboard_run_id: { type: string, required: false }

run-name: ${{ inputs.switchboard_run_id }}
```

(`run-name: Triage ${{ inputs.issue }} · ${{ inputs.switchboard_run_id }}` works too: the id
only has to appear in the name.)

## Invoke and correlation

`POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches` with
`{ ref, inputs, return_run_details: true }`.

1. When GitHub answers with the run (`workflow_run_id`, `html_url`), those become the run's
   external id and link.
2. Otherwise (`204 No Content`), the executor lists
   `GET …/workflows/{workflow}/runs?event=workflow_dispatch&created=>=<dispatch − 2 min>` and picks
   the run whose `name` or `display_title` contains the run id.
3. If the run is not listed yet, `invoke` returns `started` with no external id and records the
   dispatch in the instance state; `poll` correlates it later.

A failure while correlating never fails a dispatch that was sent.

The external id is `owner/repo/<workflow run id>`, so `poll` can find the run from the run
handle alone.

Dry runs are dispatched for real: `workflow_dispatch` has no simulation, and adding an
undeclared input would make GitHub reject the dispatch.

## Outcomes

| Dispatch response                                   | Result                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 200 / 204                                           | `started`                                                                                   |
| 429, or 403 with `x-ratelimit-remaining: 0`         | `failed` with `retryAfterSeconds` (from `Retry-After`, else `x-ratelimit-reset`, else 60 s) |
| 404, 422, 401, other 4xx                            | definitive `InvokeError`: the run is `failed`                                               |
| 503                                                 | `InvokeError` status 503: the core retries                                                  |
| other 5xx                                           | `InvokeError`, not definitive: the run is `uncertain`                                       |
| installation token refused (4xx) or bad private key | definitive `InvokeError`; nothing is dispatched                                             |
| installation token endpoint unreachable             | `InvokeError` with `sent: false`: safe to retry, nothing was dispatched                     |

## Poll

`GET /repos/{owner}/{repo}/actions/runs/{id}`:

| GitHub                                                                                     | Run state |
| ------------------------------------------------------------------------------------------ | --------- |
| `queued`, `in_progress`, `waiting`, `requested`, `pending`                                 | `running` |
| `completed` + `success`, `neutral`, `skipped`                                              | `ok`      |
| `completed` + `failure`, `cancelled`, `timed_out`, `startup_failure`, `action_required`, … | `error`   |
| run deleted (404)                                                                          | `unknown` |

On completion the executor reads usage from `GET …/runs/{id}/timing` and
`GET …/runs/{id}/jobs`. If the timing endpoint is unavailable, duration comes from the run's
timestamps and billable minutes are left out (never estimated).

## Usage dimensions

| Id                                                | Unit    | Source                                       |
| ------------------------------------------------- | ------- | -------------------------------------------- |
| `billable_minutes`                                | minutes | Sum over runner OSes, from `timing.billable` |
| `billable_minutes_ubuntu` / `_macos` / `_windows` | minutes | Per OS; reported for the OSes the run used   |
| `duration_seconds`                                | seconds | `timing.run_duration_ms`                     |
| `jobs`                                            | count   | `jobs.total_count` (latest attempt)          |

Minutes are rounded up per job, as GitHub bills them. OS multipliers (macOS, Windows) are **not**
applied: the figures are the minutes GitHub lists, not included-minute consumption. Public
repositories and self-hosted runners report 0 billable minutes.

## Meters

`api_rate_limit` (window, primary): `GET /rate_limit` → `resources.core` `used / limit`, reset
time from `reset`. The `/rate_limit` call does not count against the limit.

## Health

`GET /rate_limit` with the configured credentials: `healthy` on 200, `unhealthy` otherwise.
