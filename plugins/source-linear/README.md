# @ai-switchboard/source-linear

Linear as a source (type id `linear`, mode `push`): issue and comment webhooks, with label and state
changes derived from `updatedFrom`, plus live issue state (`resolve`), actions and webhook
provisioning. Calls only `api.linear.app`.

## Settings

| Field           | Group          | Description                                                                                          |
| --------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `apiKey`        | Authentication | **Secret.** Personal API key (sent as-is) or an OAuth token (`Bearer …`).                            |
| `webhookSecret` | Webhook        | **Secret.** The webhook signing secret.                                                              |
| `teamKeys`      | Scope          | Optional team keys (`LOL`). Other teams' events are ignored; provision creates one webhook per team. |

## Verification

`Linear-Signature` is the hex HMAC-SHA256 of the raw body with `webhookSecret`, compared in constant
time. After the signature passes, `webhookTimestamp` (milliseconds, in the JSON body) must be within
**60 s** of the core clock (either direction); a stale or missing timestamp is rejected, which stops
a captured delivery being replayed.

## Event types

Delivery id: the `Linear-Delivery` header. Artifact: `{ kind: 'linear.issue', id: 'LOL-1712', url,
version }`.

| Event type                   | When                                                                                                  | Version                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------- |
| `linear.issue.created`       | `Issue` / `create`                                                                                    | `data.updatedAt`       |
| `linear.issue.labeled`       | `Issue` / `update`, a label id in `data.labelIds` not in `updatedFrom.labelIds` — one event per label | `updatedAt:<labelId>`  |
| `linear.issue.unlabeled`     | the reverse — one event per label removed                                                             | `updatedAt:<labelId>`  |
| `linear.issue.state_changed` | `updatedFrom.stateId` present                                                                         | `data.updatedAt`       |
| `linear.issue.updated`       | any other changed field (bookkeeping like `sortOrder` ignored)                                        | `data.updatedAt`       |
| `linear.comment.created`     | `Comment` / `create`; the artifact is the comment's issue                                             | `comment:<comment id>` |

One update can produce several events (for example labeled + state_changed + updated). An update
whose `updatedFrom` has only `updatedAt` yields `linear.issue.updated` with `changedFields: []`.
Removes and other resource types produce nothing.

Attributes (flat): `team` (key), `identifier`, `title`, `state`, `stateType`, `priority` (0–4),
`priorityLabel`, `labels` (string[] of names), `assignee`, `actor`; plus

- `label` and `labelId` on (un)labeled. `label` is the name when the payload's `data.labels` has
  it, which is true for added labels; for a removed label Linear sends only the id, so `label` is
  the id then.
- `fromStateId`, `toState`, `toStateId` (and `fromState` when the payload names it; Linear
  normally sends only the previous id) on state_changed.
- `changedFields` (string[]) on updated.
- Comments carry `team`, `identifier`, `title`, `actor` and `commentId`. If Linear omits the
  issue identifier, the issue's id stands in (it also resolves).

Descriptions and comment bodies are never attributes.

## resolve

GraphQL `issue(id:)` (identifier or id) → `{ ref, title, state, stateType, labels, priority,
assignee, url, updatedAt }`; `null` when Linear says the issue doesn't exist.

## Actions

Args include `artifact: { kind: 'linear.issue', id }`.

| Action     | Args                  | Effect                                                                                                                                                              |
| ---------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addLabel` | `{ artifact, label }` | Finds the label by name (case-insensitive; the issue's team label wins over a workspace label) and sets `labelIds` to the current labels plus it. No-op if present. |
| `setState` | `{ artifact, state }` | Finds the workflow state by name in the issue's team and sets `stateId`. No-op if already there.                                                                    |
| `comment`  | `{ artifact, body }`  | `commentCreate` on the issue.                                                                                                                                       |

## Provisioning

_Register webhook_ runs `webhookCreate` with the Switchboard URL, `resourceTypes: ['Issue',
'Comment']`, the signing secret and label `AI Switchboard` — for all public teams, or once per team in
`teamKeys`. `externalId` is the webhook id(s), comma-separated.

## Credential scopes

A personal API key has its user's access. For OAuth apps: `read` (events, resolve), `write`
(actions: labels, state, comments) and `admin` (webhook provisioning). Creating webhooks requires a
workspace admin.

## Setting up the webhook by hand

Linear → Settings → API → Webhooks → New webhook: URL `https://<switchboard>/hooks/<instanceId>`,
resource types _Issues_ and _Comments_, team(s) as needed. Copy the signing secret Linear shows into
`webhookSecret`.
