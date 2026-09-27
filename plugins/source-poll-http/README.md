# @ai-switchboard/source-poll-http

The pull twin of the `webhook` source (type id `poll-http`, mode `pull`). The core calls `poll`
every `pollIntervalSeconds`; the source requests a JSON endpoint with a cursor, picks out the items
with JSONata, maps each to events and returns the new watermark.

`capabilities.network` is `['*']` because the URL is per instance. Only admins install plugins and
operators configure instances, so treat the URL like any other outbound credential use.

## Settings

| Field              | Group          | Default         | Description                                                                                                    |
| ------------------ | -------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `url`              | Request        | —               | The JSON endpoint (http/https).                                                                                |
| `method`           | Request        | `GET`           | `GET` or `POST`.                                                                                               |
| `headers`          | Request        | `{}`            | Extra headers. Don't put credentials here.                                                                     |
| `body`             | Request        | —               | JSON body for POST.                                                                                            |
| `healthUrl`        | Request        | —               | Optional cheap endpoint for `health()` (same credentials).                                                     |
| `token`            | Authentication | —               | **Secret.** Credential sent with every request.                                                                |
| `tokenHeader`      | Authentication | `authorization` | Header for the token. For `authorization` the scheme is prepended; other headers get the bare token.           |
| `authScheme`       | Authentication | `Bearer`        | Scheme for the Authorization header (`Bearer`, `Token`, …; empty for none).                                    |
| `cursorParam`      | Cursor         | —               | Parameter that carries the cursor, e.g. `updated_since`.                                                       |
| `cursorIn`         | Cursor         | `query`         | Send the cursor as a query parameter or merged into the JSON body.                                             |
| `initialWatermark` | Cursor         | —               | Cursor for the first poll. When it is a timestamp, older items are skipped.                                    |
| `cursorExpression` | Cursor         | —               | JSONata over `{ response, items, watermark }` giving the next cursor. Default: the latest mapped `occurredAt`. |
| `itemsExpression`  | Mapping        | `$`             | JSONata over the response body giving the items, e.g. `data.incidents`. A single object counts as one item.    |
| `mapping`          | Mapping        | —               | JSONata over `{ item, response }` giving one mapping result or an array (same shape as `webhook`).             |
| `eventTypes`       | Event types    | —               | Same format as `webhook`, but types are `poll-http.<object>.<verb>`.                                           |

`response` is `{ status, headers, body }`. Mapping results, attribute coercion and undeclared
types/keys behave exactly as in the webhook source. `$now()` returns the poll's start time (the
same for every item of one poll) and `$random()` is unavailable.

## Event types

Dynamic: each instance declares its own (`dynamicEventTypes: true`); the manifest's template is
`poll-http.item.found`.

## Watermark and "never re-emit"

The stored watermark is a small JSON string `{ v, cursor, at, seen }`:

- `cursor` is what the endpoint receives in `cursorParam`.
- `at` is the latest `occurredAt` emitted so far, and `seen` the dedupe keys emitted at exactly
  that instant.

Each poll drops events whose `occurredAt` is before `at`, and events at `at` that are already in
`seen`, so an endpoint whose filter is inclusive (`>=`), or one that ignores the cursor, still never
produces a duplicate, while a new item sharing the boundary timestamp is not lost. Items are emitted
in `occurredAt` order. A hand-set plain string is accepted as a watermark and treated as a cursor.

Give every item an `occurredAt` (usually its updated-at). Items without one get the poll time,
which makes them look new on every poll; the dedupe key then includes that time. Filtering by
`occurredAt` also applies with a custom `cursorExpression`, so it suits endpoints ordered by time.

## Errors and health

A non-2xx answer or a body that isn't JSON throws `PollError` (the core records it and the watermark
does not move). `health()` requests `healthUrl` when set (healthy on 2xx) and is `unknown` otherwise.

## Credential scopes

Read-only access to the polled endpoint (and the health URL). Nothing else.
