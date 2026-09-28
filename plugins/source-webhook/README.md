# @ai-switchboard/source-webhook

The universal source (type id `webhook`, mode `push`): any system that can send an HTTP POST
becomes a source without writing a plugin. How a delivery becomes events is one choice, the
_mapping mode_:

| Mode      | Setup                                           | Use it when                                                        |
| --------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `quick`   | none                                            | trying things out, or one kind of delivery whose fields you filter |
| `mapped`  | name event types, pick each fact by path        | a sender with several event kinds, or you want typed attributes    |
| `jsonata` | declare event types and write a JSONata mapping | anything the other two cannot express (loops, arithmetic, joins)   |

A new instance starts in `quick`. An instance created before the modes existed has a `mapping` and
no `mappingMode`, and keeps running as `jsonata` (the schema deliberately has no default for
`mappingMode`, so saving such an instance never switches it).

In Switchboard's Add source dialog and on the source's Settings tab, **Try it with a sample
delivery** runs a pasted body (or the source's last delivery) through the settings as you edit
them and shows the resulting events, or why there are none. Path fields suggest the paths found in
that sample, with their values.

The source makes no outbound calls (`capabilities.network: []`). SDK `^1.4.0`.

## Two words first

- **Attributes** are the named facts about an event that filters use: `attributes.status =
'failure'`. They are flat: text, numbers, booleans and lists of text. Each mode decides where they
  come from.
- **The artifact** is the thing the event is about (`{ kind, id, url?, version? }`): the deploy,
  the issue. Events about the same artifact share a trace, and the version makes a redelivery of
  the same change a duplicate.

## Paths

Quick and mapped mode read values with dotted paths into the delivery `{ body, headers, query }`:

| Path                     | Reads                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| `body.deployment.id`     | a field of the parsed JSON body                                      |
| `headers.x-github-event` | a header (names are matched case-insensitively)                      |
| `query.env`              | a query-string parameter of the webhook URL (`/hooks/<id>?env=prod`) |
| `body.labels.0`          | the first item of a list                                             |
| `body.labels.name`       | `name` of every item of a list: `["bug", "p1"]`                      |

A path that finds nothing (or `null`) has no value. Keys that contain a dot cannot be addressed;
use JSONata mode for those.

## Quick mode

Zero configuration: every delivery becomes one event.

| Field                 | Default                    | Description                                                                         |
| --------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `quickEventType`      | `webhook.request.received` | The event type. `webhook.<object>.<verb>`; the artifact kind is `webhook.<object>`. |
| `artifactIdPath`      | —                          | The artifact id. Empty: `body.id` when present, else `body-<hash>` of the raw body. |
| `artifactVersionPath` | —                          | Optional artifact version (an updated-at or revision).                              |

Attributes are the body's top-level fields (SDK `flattenAttributes`):

- text, numbers and booleans are kept; lists of them become lists of text;
- nested objects are flattened **one level** with `_`: `{ "deployment": { "id": 7 } }` gives
  `deployment_id`; deeper objects and lists of objects are dropped;
- keys are made filter-friendly: characters other than letters, digits and `_` become `_`
  (`x-kind` → `x_kind`), and a leading digit gets a `_`;
- `null`, text over 1 024 characters and anything past 64 attributes are dropped.

The event type accepts any flat attribute (`openAttributesSchema`), so a new field in the body is
simply a new attribute. The process editor's filter completion offers the attribute names seen in
recent events. Worked example — this delivery with default settings:

```json
{
  "id": "dep_48213",
  "service": "api",
  "status": "success",
  "duration_seconds": 184,
  "deployment": { "url": "https://deploys.example.com/dep_48213", "env": { "name": "prod" } }
}
```

becomes `webhook.request.received` about `webhook.request` `dep_48213`, with attributes
`{ id: "dep_48213", service: "api", status: "success", duration_seconds: 184, deployment_url:
"https://deploys.example.com/dep_48213" }` (`deployment.env` is two levels deep). A filter:
`attributes.status = 'success' and attributes.service = 'api'`.

## Mapped mode

`rules` is a list; each rule is one event type and where its facts are. The first rule whose
condition holds produces the event; a rule without a condition takes every delivery, so put it
last. A delivery that no rule takes produces no event.

| Rule field            | Required | Description                                                                            |
| --------------------- | -------- | -------------------------------------------------------------------------------------- |
| `type`                | yes      | `webhook.<object>.<verb>`, e.g. `webhook.issue.created`                                |
| `title`               | yes      | Shown in the UI                                                                        |
| `description`         |          | For the people writing filters                                                         |
| `when`                |          | `{ path, equals? }`: the value at `path` equals the text; without `equals`, has any    |
| `artifactKind`        | yes      | e.g. `issue`                                                                           |
| `artifactIdPath`      | yes      | e.g. `body.issue.id`; no value here means no event                                     |
| `artifactUrlPath`     |          | A link to the thing                                                                    |
| `artifactVersionPath` |          | An updated-at or revision                                                              |
| `occurredAtPath`      |          | ISO time or epoch seconds/ms; default the receipt time                                 |
| `attributes`          |          | `[{ name, path, type, description? }]`, type `string`, `number`, `boolean`, `string[]` |

Values are converted to the attribute's type forgivingly (numbers become text for `string`, `"42"`
becomes `42` for `number`, `"true"` becomes `true`, a single text becomes a one-item list); a value
that cannot be converted is left out. Rules with the same `type` share one event type whose
attributes are all of theirs. Worked example — a tracker that sends the event kind in a header:

```json
{
  "verification": "hmac",
  "secret": "secret://env/TRACKER_WEBHOOK_SECRET",
  "mappingMode": "mapped",
  "rules": [
    {
      "type": "webhook.issue.created",
      "title": "Issue created",
      "when": { "path": "headers.x-event-type", "equals": "issue.created" },
      "artifactKind": "issue",
      "artifactIdPath": "body.issue.id",
      "artifactUrlPath": "body.issue.url",
      "artifactVersionPath": "body.issue.updated_at",
      "attributes": [
        { "name": "priority", "path": "body.issue.priority", "type": "string" },
        { "name": "estimate", "path": "body.issue.estimate", "type": "number" },
        { "name": "labels", "path": "body.issue.labels.name", "type": "string[]" }
      ]
    }
  ]
}
```

A delivery with `x-event-type: issue.created` and `{ "issue": { "id": "ISS-42", "priority":
"high", "estimate": "3", "labels": [{ "name": "bug" }] } }` becomes `webhook.issue.created` about
`issue` `ISS-42` with `{ priority: "high", estimate: 3, labels: ["bug"] }`; a filter:
`attributes.priority = 'high' and 'bug' in attributes.labels`.

## JSONata mode

For anything else: declare `eventTypes` and write `mapping`, a JSONata expression over
`{ body, headers, query }` ([JSONata documentation](https://docs.jsonata.org/overview)).

- `eventTypes`: each entry is `{ type, title, description?, attributes: [{ name, type, description? }], example? }`.
  The source turns each into an event type with a flat attributes schema
  (`additionalProperties: false`) and an example (yours, with placeholders for missing keys).
- `mapping` returns one object or a list of them, or nothing to ignore the delivery:

```text
{ type, artifact: { kind, id, url?, version? }, attributes, occurredAt?, deliveryId? }
```

- A result whose `type` is not declared is dropped, as is one without an artifact `kind` and `id`;
  the sample preview says which and why.
- Attribute keys not declared for the type are dropped, and values are converted as in mapped mode.
- `occurredAt` accepts ISO strings or epoch numbers (seconds below 1e11, milliseconds above) and
  defaults to the receipt time.
- `$now()` and `$millis()` return the receipt time, `$random()` is unavailable, and every
  evaluation has a 2 s limit. A mapping that fails throws a `MappingError`, recorded against the
  plugin.

Worked example — a deploy tool; one mapping, two event types:

```json
{
  "mappingMode": "jsonata",
  "eventTypes": [
    {
      "type": "webhook.deploy.finished",
      "title": "Deploy finished",
      "attributes": [
        { "name": "service", "type": "string" },
        { "name": "status", "type": "string" },
        { "name": "durationSeconds", "type": "number" }
      ],
      "example": { "service": "api", "status": "success" }
    },
    {
      "type": "webhook.deploy.started",
      "title": "Deploy started",
      "attributes": [{ "name": "service", "type": "string" }]
    }
  ],
  "mapping": "{ 'type': body.status = 'started' ? 'webhook.deploy.started' : 'webhook.deploy.finished', 'artifact': { 'kind': 'deploy', 'id': body.deployment.id, 'version': body.deployment.updated_at }, 'attributes': { 'service': body.service, 'status': body.status, 'durationSeconds': body.duration_seconds }, 'occurredAt': body.finished_at }"
}
```

## Common settings

| Field                | Group        | Default            | Description                                                                      |
| -------------------- | ------------ | ------------------ | -------------------------------------------------------------------------------- |
| `verification`       | Verification | `hmac`             | `hmac`, `shared_secret` or `none`.                                               |
| `secret`             | Verification | —                  | **Secret.** HMAC key or shared secret. Required unless `verification` is `none`. |
| `signatureHeader`    | Verification | `x-signature-256`  | Header carrying the HMAC (hmac).                                                 |
| `signaturePrefix`    | Verification | `sha256=`          | Text before the digest. Empty for none.                                          |
| `algorithm`          | Verification | `sha256`           | `sha256` or `sha1`.                                                              |
| `signatureEncoding`  | Verification | `hex`              | `hex` or `base64`.                                                               |
| `sharedSecretHeader` | Verification | `x-webhook-secret` | Header carrying the shared secret (shared_secret).                               |
| `mappingMode`        | Events       | (quick)            | `quick`, `mapped` or `jsonata`; unset means `jsonata` when `mapping` is set.     |
| `deliveryIdHeader`   | Events       | `x-delivery-id`    | The sender's delivery id (GitHub: `x-github-delivery`).                          |

Every mode sees the same delivery: `body` is the parsed JSON (form-encoded bodies become an object;
anything else is the text), `headers` are lower-cased and `query` is the webhook URL's query
string. The signature header, the shared-secret header, `authorization`, `cookie` and
`proxy-authorization` are removed first, so no mode can copy a credential into an attribute.

## Duplicates

The dedupe key is `type:kind:id:<discriminator>`, where the discriminator is the artifact version,
else the delivery id (from the mapping in JSONata mode, else `deliveryIdHeader`), else — in quick
and mapped mode — a hash of the raw body. Give a version path whenever the sender has an updated-at
or etag: a redelivery then collapses even when it carries a new delivery id.

## Verification

- `hmac`: `verifyHmac` over the raw body with `secret`, checking `signatureHeader` (after
  `signaturePrefix`) in constant time.
- `shared_secret`: `safeEqual` of `sharedSecretHeader` against `secret`.
- `none`: the live source has **no `verify` method**, which is how the core knows the instance is
  unauthenticated. The type sets `allowsUnauthenticated: true`, and the UI shows the red
  _unauthenticated (evaluation)_ chip. Use it only for trying things out. `verification` is the
  only switch: the form hides the secret and header fields and shows a red warning.

The sample preview never runs `verify`, so it needs no signature.

## Setting up the sender

1. Create the instance in Switchboard; it gets the URL `https://<switchboard>/hooks/<instanceId>`.
2. In the sending system, add a webhook pointing at that URL with `Content-Type: application/json`.
3. Configure the same secret there: either as the HMAC signing key (and match the header, prefix,
   algorithm and encoding it uses) or as a custom header named like `sharedSecretHeader`.
4. Send a test delivery, open the source's Settings tab and press _Use the last delivery_ in the
   sample panel to refine the mapping against it. Stored raw bodies are kept for 30 days, so you
   can also _Replay_ one from the Events page after a change.

No credential scopes are needed: the source only receives.
