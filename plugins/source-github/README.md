# @ai-switchboard/source-github

GitHub as a source (type id `github`, mode `push`): pull requests, reviews, issues, check suites,
releases and pushes from one organization (or user), plus live state (`resolve`), tracker links
(`linked`), actions and webhook provisioning. Calls only `api.github.com`.

## Settings

| Field            | Group          | Description                                                                                                     |
| ---------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| `authMode`       | Authentication | `app` (GitHub App installation, recommended) or `token` (personal access token). Default `token`.               |
| `appId`          | Authentication | App id (app mode).                                                                                              |
| `privateKey`     | Authentication | **Secret.** App PEM private key (app mode). Literal `\n` sequences from env vars are accepted.                  |
| `installationId` | Authentication | Installation id on the owner (app mode).                                                                        |
| `token`          | Authentication | **Secret.** Personal access token (token mode).                                                                 |
| `owner`          | Scope          | Organization (or user) login.                                                                                   |
| `repositories`   | Scope          | Optional allowlist (`api` or `acme/api`). Other repositories' events are ignored; provision creates repo hooks. |
| `webhookSecret`  | Webhook        | **Secret.** The webhook secret GitHub signs with.                                                               |

App mode signs an RS256 JWT with `node:crypto`, exchanges it at
`POST /app/installations/{id}/access_tokens`, and keeps the installation token in memory until a
minute before it expires. Nothing secret is written to instance state.

## Verification

`X-Hub-Signature-256`: HMAC-SHA256 of the raw body with `webhookSecret`, `sha256=` prefix,
compared in constant time. A missing header or a mismatch is rejected before `parse`.

## Event types

Every event has `repo` (full name), `action` and `sender` (login). The delivery id is
`X-GitHub-Delivery`. `ping`, and actions not listed, produce no events.

| Event type                     | GitHub event / action                     | Artifact                                          | Version                           |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------- | --------------------------------- |
| `github.pr.opened`             | `pull_request` / `opened`                 | `github.pr` `acme/api#482`                        | PR `updated_at`                   |
| `github.pr.closed`             | `pull_request` / `closed`, not merged     | ″                                                 | ″                                 |
| `github.pr.merged`             | `pull_request` / `closed`, `merged: true` | ″                                                 | ″                                 |
| `github.pr.reopened`           | `pull_request` / `reopened`               | ″                                                 | ″                                 |
| `github.pr.labeled`            | `pull_request` / `labeled`                | ″                                                 | `updated_at:<label>`              |
| `github.pr.unlabeled`          | `pull_request` / `unlabeled`              | ″                                                 | `updated_at:<label>`              |
| `github.pr.ready_for_review`   | `pull_request` / `ready_for_review`       | ″                                                 | PR `updated_at`                   |
| `github.pr.synchronize`        | `pull_request` / `synchronize`            | ″                                                 | `updated_at:<new head sha>`       |
| `github.pr.review_submitted`   | `pull_request_review` / `submitted`       | ″                                                 | `review:<review id>`              |
| `github.issue.opened`          | `issues` / `opened`                       | `github.issue` `acme/api#12`                      | issue `updated_at`                |
| `github.issue.closed`          | `issues` / `closed`                       | ″                                                 | ″                                 |
| `github.issue.reopened`        | `issues` / `reopened`                     | ″                                                 | ″                                 |
| `github.issue.labeled`         | `issues` / `labeled`                      | ″                                                 | `updated_at:<label>`              |
| `github.issue.unlabeled`       | `issues` / `unlabeled`                    | ″                                                 | `updated_at:<label>`              |
| `github.check_suite.completed` | `check_suite` / `completed`               | `github.check_suite` `acme/api/check-suites/<id>` | suite `updated_at`                |
| `github.release.published`     | `release` / `published`                   | `github.release` `acme/api@v2.14.0`               | `published_at`                    |
| `github.push`                  | `push`                                    | `github.push` `acme/api:refs/heads/main`          | head commit sha (`after` if none) |

A merged PR emits only `github.pr.merged`, not also `closed`. Labels get the label in the version so
two labels added in the same second stay two events.

Attributes (all flat):

- **Pull requests:** `number`, `title`, `author`, `state`, `draft`, `merged`, `baseRef`,
  `headRef`, `labels` (string[]); plus `label` on (un)labeled, `headSha` on synchronize, and
  `reviewState` (`approved` / `changes_requested` / `commented`) and `reviewer` on review_submitted.
- **Issues:** `number`, `title`, `author`, `state`, `labels`; plus `label` on (un)labeled.
- **Check suites:** `status`, `conclusion`, `headBranch`, `headSha`, `app` (slug),
  `pullRequests` (`acme/api#482`, …).
- **Releases:** `tag`, `name`, `prerelease`, `draft`, `author`.
- **Pushes:** `ref`, `branch`, `tag`, `before`, `after`, `commits` (count), `forced`, `created`,
  `deleted`, `pusher`.

Titles are included; bodies, commit messages and review text never are.

## resolve and linked

- `resolve(ref)` for `github.pr` / `github.issue` reads the item live and returns
  `{ ref, state, title, labels, draft, merged, url, updatedAt }`, or `null` on 404/410. Other kinds
  throw.
- `linked(ref)` reads the PR (or issue) live and scans its title and body, skipping code blocks:
  Linear identifiers like `LOL-1712` → `{ kind: 'linear.issue', id }`; closing keywords
  (`Fixes #12`, `closes acme/web#7`), cross-repo refs (`acme/web#12`) and issue links →
  `github.issue`; `/pull/` links → `github.pr`. Common false positives (`UTF-8`, `SHA-256`,
  `RFC-…`, `CVE-…`) and the item itself are excluded.

## Actions

Args always include `artifact: { kind, id }` (`github.pr` or `github.issue`, id `owner/repo#n`).

| Action        | Args                  | Effect                                                                               |
| ------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `addLabel`    | `{ artifact, label }` | `POST /repos/{o}/{r}/issues/{n}/labels` (GitHub creates a missing label).            |
| `removeLabel` | `{ artifact, label }` | `DELETE …/labels/{label}`; an absent label counts as success.                        |
| `markReady`   | `{ artifact }` (PR)   | GraphQL `markPullRequestReadyForReview` with the PR's node id; no-op if not a draft. |
| `comment`     | `{ artifact, body }`  | `POST …/issues/{n}/comments`.                                                        |

## Provisioning

_Register webhook_ creates an organization hook (`POST /orgs/{owner}/hooks`), or one repository hook
per allowlisted repository, with the webhook secret, `content_type: json` and the events
`pull_request`, `pull_request_review`, `issues`, `check_suite`, `release`, `push`. `externalId` is
the created hook paths, comma-separated (`orgs/acme/hooks/501234987`).

## Credential scopes

GitHub App permissions (per action):

| Permission              | Level        | Needed for                                                     |
| ----------------------- | ------------ | -------------------------------------------------------------- |
| Metadata                | read         | always                                                         |
| Pull requests           | read         | pull request and review events, `resolve`, `linked`            |
| Pull requests           | write        | `markReady`, labels and comments on PRs                        |
| Issues                  | read / write | issue events, `resolve` / `addLabel`, `removeLabel`, `comment` |
| Checks                  | read         | `check_suite` events                                           |
| Contents                | read         | `push` and `release` events                                    |
| Organization → Webhooks | write        | provision (org hook)                                           |
| Repository → Webhooks   | write        | provision (repository hooks)                                   |

With a personal access token: classic `repo` (or `public_repo`) plus `admin:org_hook` (org hook) or
`admin:repo_hook` (repository hooks); fine-grained: Issues, Pull requests and Webhooks read/write,
Metadata read, and organization Webhooks read/write for an org hook.

## Setting up the webhook by hand

If you don't use _Register webhook_: in the organization (or repository) settings → Webhooks → Add
webhook, set the payload URL to `https://<switchboard>/hooks/<instanceId>`, content type
`application/json`, the secret to `webhookSecret`, and select the events above. For a GitHub App,
you can instead set the App's own webhook URL and secret to the same values and subscribe the App to
those events.
