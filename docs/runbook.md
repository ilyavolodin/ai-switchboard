# Runbook

Operating Switchboard: finding out why something did or did not run, and the handful of manual
actions that fix it. Every action below asks for a one-line reason and is written to the audit
log, in the UI and in the API alike.

Examples use the API with a token:

```bash
export SB=https://switchboard.example.com/api/v1
export AUTH="Authorization: Bearer $SWITCHBOARD_TOKEN"
```

## Why did this not run?

Start from the thing, not the logs. Every stage writes its decision to Postgres, so the trace
already has the answer.

1. Open **Activity** and search for the artifact: a PR number (`#482`), an issue key
   (`LOL-1712`), a monitor id, or `kind:id`. The API equivalent is
   `GET $SB/trace?artifact=LOL-1712`.
2. The result is one timeline for that artifact: each event, each filter decision with its
   expression and result, the batch opening and closing, each gate check, the budget check with
   the binding limit and the meter readings at that moment, the invoke with its external link,
   steps, tracking updates and the terminal state.
3. For an event nothing took, the trace (and the event's panel on the source's _Events_ tab)
   says **Why nothing ran**, one line per process with a trigger on that source:
   `Autofix did not take it: process is disabled`, `… trigger "PR labeled" is disabled`,
   `… event type x is not in trigger "…" (subscribes to …)`, `… filter false: <expr>`,
   `… filter error: <msg>`, `… type x is muted on the source`, `… source is disabled`. The reason
   is what match recorded when the event arrived; a line marked **(now)** was computed from the
   current configuration because nothing was recorded for that process (an older event, or a
   trigger added later). No line at all means no process has a trigger on the source. The API
   equivalent is `GET $SB/events/<id>` → `explanations`. _Send test event_ on a source shows
   the same answer in a banner with a link to the event's trace.
4. Find where it stopped and act on that stage:

| Where it stopped                                                      | What it means                                                                         | What to do                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No event at all                                                       | The delivery never arrived or failed verification                                     | Check the source's _Overview_ for verify failures (logged with the remote address). Re-register the webhook (_Register webhook_). Check the sender's delivery log                                                                         |
| `source_disabled`                                                     | The source instance is off; the event was stored, not processed                       | Enable the source, then _Replay_ the event                                                                                                                                                                                                |
| `source_throttled`                                                    | Dropped by `eventCapPerHour` / `eventCapPerDay`                                       | Raise the cap if the flood was legitimate; a sweep covers the gap                                                                                                                                                                         |
| `type_muted`                                                          | The event type is muted on this source                                                | Unmute it in the source's settings                                                                                                                                                                                                        |
| `event_invalid`                                                       | The plugin produced an event that does not match its declared schema                  | A plugin bug; the Plugins page counts it. Upgrade or report the plugin                                                                                                                                                                    |
| `unmatched`                                                           | No enabled trigger's source, event types and filter all matched                       | Read _Why nothing ran_. A disabled process: switch _Enabled_ on (process editor › Basics, or the detail page), then _Replay_ the event. Otherwise fix the trigger's event types or filter (the editor evaluates it against recent events) |
| `filter_error`                                                        | The filter threw and counted as false                                                 | Fix the expression; the trace shows the error                                                                                                                                                                                             |
| `deduped`                                                             | This process already saw this dedupe key within 7 days                                | Expected for redeliveries. If it was a genuinely new change, the source's `artifact.version` did not change: a plugin issue                                                                                                               |
| Batch `open` for long                                                 | Still collecting: debounce keeps extending while events arrive                        | Lower `debounceSeconds` or `maxAgeSeconds`                                                                                                                                                                                                |
| `held: process_disabled` / `source_disabled` / `destination_disabled` | Something in the path is off                                                          | Enable it. The next sweep does the work; use _Run now_ for an immediate run                                                                                                                                                               |
| `held: destination_unhealthy`                                         | The destination's `health()` is failing                                               | Open the destination; usually credentials (see rotation below)                                                                                                                                                                            |
| `held: plugin_unavailable`                                            | The plugin that provides the type did not load                                        | Plugins page and startup logs; reinstall or roll back the plugin version                                                                                                                                                                  |
| `held: breaker_open`                                                  | The process failed `threshold` times in a row                                         | See breakers below                                                                                                                                                                                                                        |
| `held: quiet_hours`                                                   | Inside the process's quiet window                                                     | Expected. The first sweep after the window picks it up                                                                                                                                                                                    |
| `awaiting_approval`                                                   | The approval rule required a person                                                   | **Approvals** → approve or reject with a reason                                                                                                                                                                                           |
| `held: paused`                                                        | The backend refused because the target is paused on its side                          | Unpause it in the backend (for example, the routine)                                                                                                                                                                                      |
| `throttled`                                                           | A budget or meter ceiling; the trace names the binding limit                          | Wait for the window to reset, raise the budget, or lower the ceiling margin. Not re-queued: the next sweep does the work                                                                                                                  |
| Run `failed`                                                          | Definitive error at invoke: input failed `inputSchema`, a `before` step failed, a 4xx | Read the run's errors; fix the mapping or target in the editor with the live preview                                                                                                                                                      |
| Run `uncertain`                                                       | The response was lost and the destination is not idempotent                           | Wait for tracking or the deadline. Never re-run it blindly; see below                                                                                                                                                                     |
| Run `unknown`                                                         | Nothing closed the run before `trackingDeadlineMinutes`                               | Check the external link. For callbacks, check the backend actually posts to `/callbacks/<destinationId>` with a valid signature                                                                                                           |
| Run `error`                                                           | The backend ran it and reported errors                                                | The external link has the details                                                                                                                                                                                                         |

A source that should have sent something but did not: the Board's _Needs attention_ panel lists
silent sources (no events for `sourceSilenceMinutes`), and the system notifier alerts on them. It
also lists a disabled process that has never run but turned events away in the last 24 hours
(usually one created disabled and forgotten), with an _Enable_ action. Processes created in the
editor start enabled.

## Breakers

A process's breaker opens after `gates.breaker.threshold` consecutive `error` or `unknown` runs.
While it is open every batch and sweep of that process is held with `breaker_open`, not lost.
It closes by itself after `cooldownMinutes`, or by hand:

1. Look at the last failed runs (the red banner on the process lists them) and fix the cause.
2. Press **Reset breaker** on the process, or:

   ```bash
   curl -X POST -H "$AUTH" -H 'content-type: application/json' \
     -d '{"reason":"fixed the routine prompt"}' "$SB/processes/<processId>/breaker/reset"
   ```

3. Press **Run now** if the work should not wait for the next sweep.

## Credential rotation

Secret values are never in Postgres, so rotation happens in the secret provider. (For
credentials an instance rotates on its own, see _Credentials instances rotate themselves_ below.)

1. Put the new value where the provider reads it: the environment variable for `env`
   (`secret://env/GITHUB_TOKEN`), the mounted file for `file`, the vault path for a vault provider.
   For `env`, that means a restart or rollout with the new environment; for `file`, updating the
   Kubernetes secret is enough once the kubelet syncs the file.
2. Press **Reload instance** on the source, destination or notifier (or
   `POST $SB/sources/<id>/reload`, `POST $SB/destinations/<id>/reload`,
   `POST $SB/notifiers/<id>/reload` with a reason). The core resolves the references again and
   rebuilds that one instance. The replica that served the request rebuilds it at once; the
   reload also bumps the instance's `config_version`, so every other replica rebuilds it within
   `SWITCHBOARD_INSTANCE_SYNC_SECONDS` (10 s). Wait that long before judging the result on a
   multi-replica install.
3. Confirm the instance's secret references show a fresh _last resolved_ time and its health is
   green. `switchboard doctor` checks every reference and every instance.

Changing a **secret provider** itself (Settings › Secret providers: add, enable or disable,
edit, rename or reload it) rebuilds every source, destination and notifier whose settings reference
it, on every replica (the others within `SWITCHBOARD_INSTANCE_SYNC_SECONDS`); the provider's row
lists them with their status afterwards. Renaming a provider does not
rewrite references: instances still naming the old `secret://<old>/…` fail with
`secret_error: secret provider "<old>" is not configured or not running` until you edit them. A
provider that anything still references cannot be deleted (409 naming the users); point those
references elsewhere first.

### Credentials instances rotate themselves

Some credentials are replaced every time they are used. The Claude Routines seat meters' OAuth refresh
token, for example, is swapped for a new one on each refresh. Switchboard keeps the current value
in a **writable secret provider** that the instance's settings already reference, under the name
`switchboard-<instance id>-<key>`. It never keeps it in Postgres.

- The built-in `env` provider is read-only. Use the `file` provider with **Store rotated
  credentials** (`writable: true`) on a directory that is writable and persistent, such as a volume,
  not a read-only Kubernetes secret mount. Reference the seed token from it, for example
  `secret://file/seat-refresh-token`. Every replica must see the same directory, or each replica
  rotates its own chain.
- If no referenced provider is writable, the instance reports **unhealthy** ("rotated OAuth tokens
  need a writable secret provider: …"), its seat meters stay stale, and `switchboard doctor` fails
  the instance. No token is spent, so fixing the provider and pressing **Reload instance** is
  enough.
- **Upgrading from a version that kept rotated tokens in `instance_state`:** no migration deletes
  them. The rotated refresh token is the only live one; the seed in the settings has been used
  up. On the first meter read with a writable provider in place, the instance moves the tokens into
  the provider and rewrites the state row without them. Until then they stay where they were and
  the instance is unhealthy. If you would rather drop them, delete the instance's `oauth` state row
  and paste a fresh refresh token into the settings.
- Pasting a new refresh token into the settings restarts the chain from it.
- Deleting the instance deletes its rotated values from the provider.

When credentials are revoked before you rotate, invokes fail with 401/403, the destination is marked
unhealthy, its processes are held with `destination_unhealthy`, and the system notifier alerts.
Nothing is lost; the next sweep after the reload does the work.

## Replaying events

**Replay** on an event (or `POST $SB/events/<eventId>/replay` with a reason) re-injects the stored
raw body through the source's `parse`, as if it had just arrived. Replayed events carry
`replayOf`, so the trace tells them apart. Dedupe still applies: a replay of an event a process
already ran is `deduped` for that process. That is the point: replay is safe to press. Raw bodies
are kept for `rawBodiesDays` (30 by default); older events cannot be replayed.

To force a new run regardless, use **Run now** on the process (`POST $SB/processes/<id>/run`),
which starts a manual batch through the gate.

## Uncertain runs

A run is `uncertain` when the destination is not idempotent and the invoke's response was lost
(timeout, reset, 5xx after send). The core never invokes it again, because the backend may
already be doing the work. Tracking (poll or callback) usually settles it; otherwise the deadline
makes it `unknown`.

If you know the outcome (you checked the backend), close it by hand:

```bash
curl -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"status":"ok","reason":"checked the session, it finished"}' "$SB/runs/<runId>/close"
```

If the work did not happen, close it `error` or `unknown` and use **Run now**. An invoke that gets
no answer within its timeout (the destination's **Invoke timeout** cap, else the destination
type's value, else 300 s) is treated as a lost response: `uncertain` when not idempotent. A run
left `invoking` past its attempt's deadline (a replica died mid-invoke) becomes `uncertain` on its
own; an attempt that died in its `before` steps never reached the backend and is resumed instead.

## Steps in doubt

Each `before` and `after` step is journaled: written `started` before the action runs, settled
after. A resumed run skips settled steps and runs the ones never started. A step left `started` by
a replica that died is in doubt:

- An idempotent action (add a label, set a state) runs again.
- A non-idempotent `before` action (post a comment) fails the run with
  `step_in_doubt:before[<index>] <action>` before anything is invoked. Check whether the side
  effect happened, then **Run now** if the work should still happen.
- A non-idempotent `after` action is shown **in doubt** (`uncertain`) on the run and is not
  repeated; the other steps still run.

A run's notifications are claimed before they are sent, so a redelivered job never sends one
twice. A notification left `sending` (the trace says "claimed, delivery not confirmed") may not
have gone out.

## Soft-holds and stale meters

- **Soft-hold:** when a backend answers "out of capacity" with a retry-after (a 429), the core
  opens a soft-hold on that destination for that long, and batches are throttled with the
  soft-hold named. It ends by itself. If you know capacity is back, **Clear soft-hold** on the
  destination (`POST $SB/destinations/<id>/soft-hold/clear`).
- **Stale meter:** a meter whose latest reading is older than `meterStalenessMinutes` is shown
  grey with its last-read time. Ceilings stop using it and only the counters (runs per hour and
  day, usage caps) gate. Press **Read meters** (`POST $SB/destinations/<id>/meters/read`) to see the
  error; usually the meter endpoint's credential (for Claude Routines, the seat's OAuth refresh
  token).

## Applying configuration from CI

Keep the configuration in git as YAML and apply it from CI with a dedicated admin API token. The
full format and a GitHub Actions example are in [configuration](configuration.md#applying-from-ci).
In short:

```bash
switchboard export -o switchboard.yaml                       # once, to start
switchboard apply -f switchboard.yaml --dry-run --reason "PR #123"   # on every pull request
switchboard apply -f switchboard.yaml --reason "merge abc1234"       # on the default branch
```

A dry run prints the same change list as the real apply and exits 1 on errors, so it is the check
to require on the pull request. Apply is all or nothing.

## doctor

`switchboard doctor` checks the database connection, migrations, plugin manifests, secret
resolution for every reference, and every enabled instance's `health()` (an instance that needs a
writable secret provider and has none fails here), and prints one ✓ or ✗
line per check. It exits 1 if any check fails, so it works as a deploy smoke test. Run it with the
server's environment:

```bash
docker compose -f deploy/docker-compose.yml exec switchboard switchboard doctor
kubectl exec deploy/switchboard -- switchboard doctor
```

## Locked out

Switchboard has no email delivery, so a forgotten password (or a forgotten email) is reset by a
person, never by a link.

- **Someone else is an admin:** they reset the password in **Settings › Users** ("Reset
  password", with a reason). The account signs in with that temporary password and must choose a
  new one first.
- **Nobody can sign in** (the only admin forgot the password, or which email it was): run the CLI
  on the server, with the server's environment. It talks to Postgres directly (`DATABASE_URL`),
  so it needs no session and no token; access to the server is the credential.

```bash
# Every account: email, role, password, OIDC, pending change, last sign-in
docker compose -f deploy/docker-compose.yml exec switchboard switchboard users list
kubectl exec deploy/switchboard -- switchboard users list --json

# A generated temporary password, printed once
docker compose -f deploy/docker-compose.yml exec switchboard \
  switchboard users reset-password admin@switchboard.local --reason "forgot the admin password"

# Break glass: create a local admin (or promote an existing account) with a temporary password
kubectl exec deploy/switchboard -- switchboard users create-admin ops@example.com \
  --reason "only admin left the company"
```

`reset-password <email>` refuses an email with no account and lists close matches (the same
local part, a typo, the same domain). `--password <pw>` sets a password of your choice instead of
a generated one; it is checked against the password rules and not printed. `--password-stdin`
reads it from stdin instead (`printf '%s\n' "$PW" | switchboard users reset-password ...
--password-stdin`), so it stays out of the shell history and the process list. Either way the
password is temporary: the next password sign-in must change it. The reset signs the account out
of every session, clears its failed sign-in count (so a 429 lockout ends too) and writes an
`audit_log` row with actor `cli@<hostname>` and the `--reason` (default "password reset from the
server CLI"); the value is never logged or audited. API tokens are not touched; revoke them in
**Settings › Users** if the account was compromised.

`create-admin` is the same for an account that must become an admin: it creates the account
when the email is new, promotes it otherwise (audited as a role change), and sets a temporary
password. Use it when every admin signs in through an issuer that is down, or the only admin left.

The local admin's email defaults to `admin@switchboard.local` (or `SWITCHBOARD_BOOTSTRAP_ADMIN`).
In evaluation mode the sign-in page's **Forgot password or email?** panel shows it; outside
evaluation mode the page never names an email.

## Backups and restore

- **Postgres is the only state.** Back it up the way you back up any Postgres: managed snapshots,
  or `pg_dump -Fc "$DATABASE_URL" > switchboard.dump`. Restore with `pg_restore` into an empty
  database and start the server; migrations run at start.
- **Plugins.** Keep `$SWITCHBOARD_HOME/plugins.lock.json` (exact versions and integrity hashes)
  with your deployment, or bake plugins into the image with `SWITCHBOARD_PLUGINS`, so a restore
  loads the same code.
- **Secrets** live in your secret provider, not in the dump. A restored installation needs the
  same environment or mounted files.
- **Configuration only:** `switchboard export` is a readable backup of every instance and process
  (without runs, events or users), restorable with `switchboard apply`.

## Upgrades

1. Read the release notes for SDK majors. A plugin whose `switchboard.sdk` range excludes the new
   major is marked incompatible and its processes are held.
2. Take a database backup.
3. Roll out the new image. Migrations run at start. The Helm chart rolls replicas one at a time
   with `maxUnavailable: 0`, and pg-boss re-delivers any job a stopping replica had in flight.
4. Run `switchboard doctor`.

## Scaling to replicas

Replicas are identical and coordinate only through Postgres: pg-boss hands each job to one
replica, and unique constraints keep runs once. To scale:

- Run two or more replicas behind the load balancer (the Helm chart's `replicaCount`, default 2).
  `/readyz` gates traffic until Postgres is reachable and plugins are loaded; `/healthz` is
  liveness.
- Every replica must load the same plugins (same image, or the same `$SWITCHBOARD_HOME`), or
  types flap between available and unavailable. Plugins added or removed on the Plugins page
  converge by themselves: each replica's sync pass (at boot and every
  `SWITCHBOARD_PLUGIN_SYNC_SECONDS`, 60 s) installs recorded plugins into its own
  `$SWITCHBOARD_HOME` and removes ones an admin removed (the `plugins.remove_requested_at`
  tombstone), unregistering them without a restart. Plugins added with the CLI on one replica
  are that replica's alone, and are left alone by the sync pass unless an admin removes them.
- Instance changes converge the same way. The replica that handles a change to a source,
  destination, notifier or secret provider (create, edit, caps, enable or disable, reload, delete,
  `apply`) rebuilds it at once; every other replica rebuilds it on its next reconcile pass (at
  boot and every `SWITCHBOARD_INSTANCE_SYNC_SECONDS`, 10 s), so for up to that long a request
  landing on another replica may still see the old configuration. Each write bumps the row's
  `config_version`; a pass compares those with what the replica built and rebuilds only what
  moved, plus the dependents of a changed secret provider. `switchboard.instance.rebuilds`
  counts what the passes rebuilt, by `kind` and `change`. If one replica keeps serving old
  settings, check its logs for `could not reconcile instances with the database`; a restart
  rebuilds everything.
- To separate ingress and API from pipeline work, run some replicas with
  `SWITCHBOARD_WORKERS=false`: they serve the UI, API, hooks and callbacks and run no pipeline
  workers or scheduler.
- The About panel (`GET $SB/about`) lists replicas with their last heartbeat; each emits
  `switchboard.heartbeat` every 30 seconds.
- Size Postgres connections for replicas × pool size.

## Retention

Defaults: events 90 days, raw bodies 30 days, dispatches and batches 90 days, meter readings 90
days, hourly statistics 2 years. Runs, steps, approvals, audit and process versions are kept
indefinitely. A nightly job prunes. Change retention on **Settings → Retention** or with
`PUT $SB/settings`. Shorter raw-body retention limits how far back _Replay_ works.
