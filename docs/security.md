# Security

Switchboard holds credentials that can start work in other systems. The design keeps each
credential narrow, keeps secret values out of the database and out of expressions, and makes the
payload harmless: a forged event can waste budget but cannot direct work. This page is for the
people who deploy and operate it.

## Sign-in and roles

- **OIDC** against any issuer (Google Workspace, Okta, Entra ID, Keycloak, GitHub through an OIDC
  bridge): authorization-code flow with PKCE and ID-token validation. Configure
  `SWITCHBOARD_OIDC_ISSUER`, `SWITCHBOARD_OIDC_CLIENT_ID`, `SWITCHBOARD_OIDC_CLIENT_SECRET` and
  optionally `SWITCHBOARD_OIDC_ALLOWED_DOMAINS`. The redirect URI is
  `<SWITCHBOARD_PUBLIC_URL>/api/v1/auth/oidc/callback`. The ID token must say
  `email_verified: true`: the first OIDC sign-in binds the issuer's subject to the account with
  that email, so an unverified address could otherwise take over an account. For an issuer that
  never sends the claim, `SWITCHBOARD_OIDC_TRUST_UNVERIFIED_EMAIL=true` accepts it, but such a
  sign-in is still refused (409) for an account that has a password and no OIDC identity yet. The
  variable applies to an issuer configured in the environment; an issuer saved in Settings uses
  its own `oidc.trustUnverifiedEmail` setting (default off).
- **Local passwords** work alongside OIDC (or without it). An account can have a password, an
  OIDC identity, or both. Passwords are hashed with scrypt; the rules are at least 8 characters,
  not the account's email, and not one of the most common passwords. Failed sign-ins and failed
  password confirmations are throttled in Postgres (`login_attempts`), so the limits hold across
  replicas: within any 5 minutes, 10 failures from one client address, or 5 against one account
  (the email, trimmed and lower-cased), refuse further sign-ins from that address or to that
  account with 429 `too_many_attempts` and a `Retry-After` header, even when the password is
  right. Five failed password confirmations do the same for that user. A successful sign-in
  clears the account's count, not the address's. The table stores `sha256` of the email, never
  the address, and the nightly `auth.prune` job drops attempts older than an hour. A sign-in for
  an email with no password still pays the scrypt cost, so the response time does not tell
  which emails have accounts.
- **Temporary passwords.** A password an admin sets (Settings › Users: "Set password" / "Reset
  password", with a reason) and the generated bootstrap password are temporary. The session that
  signs in with one can only read `/auth/me`, change the password or sign out; every other route
  answers 403 `password_change_required` until the password changes. Setting, resetting or
  removing a password signs the user out everywhere; a user changing their own password signs out
  their other sessions. The audit log records that a password changed, never the value. API tokens
  are separate credentials: revoke them separately when an account is compromised.
- **Recovery needs server access.** There is no emailed reset link. A forgotten password is reset
  by an admin in Settings › Users, or, when nobody can sign in, by `switchboard users
reset-password <email>` (and `users create-admin <email>` to break glass) run on the server.
  The CLI reads `DATABASE_URL` and changes Postgres directly, so whoever can run it already holds
  the database credentials; it adds no network surface. Each reset sets a temporary password
  (printed once), revokes the account's sessions, clears its sign-in failures and writes
  `audit_log` with actor `cli@<hostname>` and a reason; the value is never recorded.
  `switchboard users list` shows every account's email to the same people. The sign-in page names
  no email, except the bootstrap local admin's in evaluation mode (`MeResponse.evaluationAdminEmail`).
- **A user row is required.** A valid token from the right issuer for an unknown email lands on
  an "ask an admin" page.
- **Bootstrap** always leaves a way in. With OIDC and `SWITCHBOARD_BOOTSTRAP_ADMIN`, that email is
  created as an admin who signs in through the issuer. Otherwise, while no account has a password
  (and, with OIDC, no admin exists yet), a local admin is created: its generated password is
  printed once to the log and must be changed at first sign-in; a password given in
  `SWITCHBOARD_ADMIN_PASSWORD` is used as is.
- **Sessions** are HttpOnly, SameSite=Lax cookies (Secure when the public URL is https, or with
  `SWITCHBOARD_SECURE_COOKIES=true`), backed by a `sessions` row so an admin can revoke them, with
  a 12-hour sliding lifetime.
- **Roles**, enforced by the API:

  | Role       | Can                                                                            |
  | ---------- | ------------------------------------------------------------------------------ |
  | `viewer`   | Read everything (users: email and role only, via `GET /users/directory`)       |
  | `operator` | Also sources, destinations, processes, approvals, manual runs, replays, export |
  | `admin`    | Also plugins, users, secret providers, notifiers, settings, apply              |

- **API tokens** (for the CLI and CI) are personal, scoped to a role no higher than their
  owner's, shown once, and revocable. Use a dedicated admin token for CI that applies
  configuration, so the audit log names it.
- **Evaluation mode** (`SWITCHBOARD_EVALUATION=true`) allows unauthenticated webhook instances and
  a plain-http OIDC issuer. While OIDC is not configured the UI shows a persistent evaluation
  banner; a production install that deliberately uses local accounts only (evaluation off) shows
  none. Don't run evaluation mode on a network you don't control.

## Unauthenticated surfaces

Exactly these routes answer without a session or token:

| Route                            | Authenticated by                                    |
| -------------------------------- | --------------------------------------------------- |
| `POST /hooks/:sourceId`          | The source's `verify` (signature or shared secret)  |
| `POST /callbacks/:destinationId` | The destination's `verifyCallback`                  |
| `GET /healthz`, `GET /readyz`    | Nothing; they return no configuration               |
| `GET /metrics`                   | Nothing, when Prometheus is enabled (see hardening) |

Hooks and callbacks are rate-limited per instance at the HTTP layer, above each source's own
event caps. A rejected request gets an empty 401 and is logged with the remote address. A source
type without `verify` is refused, except a `webhook` instance explicitly marked
_unauthenticated (evaluation)_, which the UI shows with a red chip.

## Secrets

- Settings store references: `secret://<provider>/<name>`. A secret-provider plugin resolves
  them when an instance is built. Reference providers: `env` (environment variables) and `file`
  (mounted files, the Kubernetes-secret pattern); community providers cover Vault, GCP Secret
  Manager and AWS Secrets Manager.
- Values live only in the built instance's memory. No API endpoint returns one; the UI shows
  reference names and last-resolved times.
- Expressions cannot read secret values. `$secretRef(name)` yields a reference the destination
  bridge resolves after evaluation.
- `switchboard export` writes instance settings as stored, which means references, never values.
- Rotation is a change in the provider plus **Reload instance** ([runbook](runbook.md#credential-rotation)).

## Payload safety

A destination receives only what the process's input mapping produces from declared attributes and
artifact references. The recommended mapping style is references plus a mode and a run id, so the
started process re-reads real state instead of trusting the event. Destinations that take free text
(Claude Routines) receive it as untrusted data: the routine's prompt must treat it that way and
opt in to acting on it.

## Plugins are trusted code

Plugins run in the core's process with its privileges, the same model as Grafana backend plugins
and Backstage. There is no sandbox. The controls are at install time:

- Only admins install (`switchboard plugins add`, or the Plugins page).
- `plugins.lock.json` pins each plugin's exact version and integrity hash.
- The manifest's `capabilities` (network hosts, secret names) are shown before the plugin is
  loaded, and enforced for the SDK's `HttpClient` and secret resolution. A plugin that uses raw
  `fetch` or sockets bypasses the network check; review the code of anything not in the catalogue.
- npm install scripts run during `plugins add`. Install in a build stage (`SWITCHBOARD_PLUGINS`
  build argument) rather than on a running production container.
- The project publishes a catalogue of reviewed plugins. Anything else is at the installer's
  discretion.
- The core attributes exceptions and invalid events to the plugin that produced them and shows
  the counts on the Plugins page, so a misbehaving plugin is visible.

## Actions and audit

Every action a step performs is recorded in `steps` with the run that caused it, so any label,
comment or dispatch the system made traces back to a process, a trigger and a human-set rule.
Every configuration change and manual action writes an `audit_log` row with actor, before, after
and reason.

Reasons are required by default: the API refuses a change without a one-line reason (400). An
admin can turn this off under Settings › General › "Require a reason for every change"
(`requireReasons`). The switch itself is admin-only and audited like any setting. With reasons
optional, the UI stops prompting (destructive actions still ask to confirm, with an optional
note), and a change without a reason is audited as `(no reason given)`. The actor, the time and
the before and after values are recorded either way, so turning reasons off loses the _why_, not
the _who_ or the _what_. Each replica caches the setting for up to 5 seconds, so for a few
seconds after the switch flips, another replica may still refuse a change without a reason (when
it was just turned off) or accept one (when it was just turned on). A failed read of the setting
counts as "required".

Scope the credentials used for actions to what the actions need (the `github` source
documents the App permissions per action).

## Data

Events and raw bodies can contain internal text (titles, alert messages). Retention is
configurable and defaults to 90 days for events and 30 days for raw bodies. Nothing in the design
requires end-user personal data, and source plugins map only documented attributes.

## Hardening checklist

- [ ] OIDC configured, `SWITCHBOARD_EVALUATION` unset, allowed domains set (or, for local
      accounts only, evaluation unset and every bootstrap password changed).
- [ ] Remove passwords from accounts that should sign in only through OIDC (Settings › Users).
- [ ] `SWITCHBOARD_PUBLIC_URL` is `https://…`, TLS terminated at the ingress, Secure cookies on.
- [ ] `DATABASE_URL` and OIDC client secret come from a secret store (the Helm chart's
      `database.existingSecret`), not plain values.
- [ ] Postgres reachable only from the Switchboard pods, with its own backups.
- [ ] Every `x-secret` field is a `secret://` reference; `switchboard doctor` passes.
- [ ] Every push source verifies deliveries; no instance carries the unauthenticated chip.
- [ ] `/metrics` is not exposed through the public ingress (scrape it inside the cluster), or
      `SWITCHBOARD_PROMETHEUS=false` with OTLP instead.
- [ ] Plugins baked into the image at build time from pinned versions; the lockfile is kept.
- [ ] Credentials for sources and destinations are scoped to the actions they perform.
- [ ] A system notifier is configured, so breaker openings, plugin load failures and failed
      callback verifications reach a person.
- [ ] API tokens are per person or per CI pipeline, with the lowest role that works; unused ones
      revoked.
- [ ] The container runs as its non-root user with a read-only root filesystem where your
      platform allows it (`$SWITCHBOARD_HOME` on a volume if you install plugins at run time).
