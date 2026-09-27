# @ai-switchboard/source-webhook

The universal source (type id `webhook`, mode `push`). You name the event types an instance
produces and write a JSONata mapping from the delivery to `type`, `artifact` and `attributes`, so
any system that can send an HTTP POST becomes a source without writing a plugin.

The source makes no outbound calls (`capabilities.network: []`).

## Settings

| Field                | Group        | Default            | Description                                                                              |
| -------------------- | ------------ | ------------------ | ---------------------------------------------------------------------------------------- |
| `verification`       | Verification | `hmac`             | `hmac`, `shared_secret` or `none`.                                                       |
| `secret`             | Verification | —                  | **Secret.** HMAC key or shared secret. Required unless `verification` is `none`.         |
| `signatureHeader`    | Verification | `x-signature-256`  | Header carrying the HMAC (hmac).                                                         |
| `signaturePrefix`    | Verification | `sha256=`          | Text before the digest. Empty for none.                                                  |
| `algorithm`          | Verification | `sha256`           | `sha256` or `sha1`.                                                                      |
| `signatureEncoding`  | Verification | `hex`              | `hex` or `base64`.                                                                       |
| `sharedSecretHeader` | Verification | `x-webhook-secret` | Header carrying the shared secret (shared_secret).                                       |
| `deliveryIdHeader`   | Mapping      | `x-delivery-id`    | Sender's delivery id, used when the mapping gives no `deliveryId`.                       |
| `eventTypes`         | Event types  | —                  | The instance's event types (below).                                                      |
| `mapping`            | Mapping      | —                  | JSONata over `{ body, headers, query }` yielding one mapping result or an array of them. |

### Event types

Each entry is `{ type, title, description?, attributes: [{ name, type, description? }], example? }`.
`type` must be `webhook.<object>.<verb>`; attribute types are `string`, `number`, `boolean` and
`string[]`. The source turns each entry into an `EventTypeSpec` with a flat attributes schema
(`additionalProperties: false`) and an example (yours, with placeholders for missing keys). The
type's manifest itself lists only a template, `webhook.event.received`; instance types come from
`instanceEventTypes(settings)`.

### Mapping results

```text
{ type, artifact: { kind, id, url?, version? }, attributes, occurredAt?, deliveryId? }
```

- A result whose `type` is not declared is dropped, as is one without an artifact `kind` and `id`.
- Attribute keys not declared for the type are dropped. Values are coerced forgivingly: numbers
  and booleans become strings for a `string` attribute, numeric strings become numbers, `"true"` /
  `"false"` become booleans, a lone string becomes a one-element `string[]`. Values that cannot be
  represented are dropped.
- `occurredAt` accepts ISO strings or epoch numbers (seconds below 1e11, milliseconds above) and
  defaults to the delivery's receipt time.
- The dedupe key is `type:kind:id:(version ?? deliveryId)`. Give `artifact.version` (an updated-at
  or etag) whenever the sender has one; otherwise redeliveries collapse only if they carry the same
  delivery id.

The mapping sees `body` (parsed JSON; form-encoded bodies become an object; anything else is the
text), `headers` (lower-cased) and `query`. The signature header, the shared-secret header,
`authorization`, `cookie` and `proxy-authorization` are removed first, so a mapping cannot copy a
credential into an attribute. Evaluation is deterministic: `$now()` and `$millis()` return the
delivery's receipt time, `$random()` is unavailable, and every evaluation has a 2 s limit. A mapping
that fails throws a `MappingError`, which the core records against the plugin.

## Verification

- `hmac`: `verifyHmac` over the raw body with `secret`, checking `signatureHeader` (after
  `signaturePrefix`) in constant time.
- `shared_secret`: `safeEqual` of `sharedSecretHeader` against `secret`.
- `none`: the live source has **no `verify` method**, which is how the core knows the instance is
  unauthenticated. The type sets `allowsUnauthenticated: true`, and the UI shows the red
  _unauthenticated (evaluation)_ chip. Use it only for trying things out.

## Example settings

A deploy tool that signs its body like GitHub does:

```json
{
  "verification": "hmac",
  "secret": "secret://env/DEPLOYBOT_WEBHOOK_SECRET",
  "eventTypes": [
    {
      "type": "webhook.deploy.finished",
      "title": "Deploy finished",
      "attributes": [
        { "name": "service", "type": "string" },
        { "name": "environment", "type": "string" },
        { "name": "status", "type": "string" },
        { "name": "durationSeconds", "type": "number" },
        { "name": "tags", "type": "string[]" }
      ],
      "example": { "service": "api", "environment": "production", "status": "success" }
    }
  ],
  "mapping": "body.status in ['success', 'failure'] ? { 'type': 'webhook.deploy.finished', 'artifact': { 'kind': 'deploy', 'id': body.deployment.id, 'url': body.deployment.url, 'version': body.deployment.updated_at }, 'attributes': { 'service': body.service, 'environment': body.environment, 'status': body.status, 'durationSeconds': body.duration_seconds, 'tags': body.tags }, 'occurredAt': body.finished_at }"
}
```

## Setting up the sender

1. Create the instance in Switchboard; it gets the URL `https://<switchboard>/hooks/<instanceId>`.
2. In the sending system, add a webhook pointing at that URL with `Content-Type: application/json`.
3. Configure the same secret there: either as the HMAC signing key (and match the header, prefix,
   algorithm and encoding it uses) or as a custom header named like `sharedSecretHeader`.
4. Send a test delivery and check the instance's Events page; the raw body is kept for 30 days, so
   you can refine the mapping and _Replay_ it.

No credential scopes are needed: the source only receives.
