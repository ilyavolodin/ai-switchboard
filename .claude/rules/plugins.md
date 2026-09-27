---
paths:
  - 'plugins/**'
---

# Reference plugin conventions

- A plugin package is `plugins/<kind>-<name>/` named `@ai-switchboard/<kind>-<name>`. Its
  `package.json` has `"keywords": ["switchboard-plugin"]` and a `switchboard` field
  (`entry`, `source`, `sdk`), and the SDK is a peer dependency.
- `src/plugin.ts` default-exports `definePlugin({...})`. Put types in their own files
  (`src/source.ts`, `src/executor.ts`, `src/events.ts`) once they grow.
- Declare `capabilities.network` with the exact hosts you call. Use `ctx.http` (the SDK's
  `HttpClient`), never raw `fetch`, so the capability check and tracing apply.
- Settings schemas are JSON Schema 2020-12. Mark every credential with `"x-secret": true`. The
  core stores a `secret://` reference and hands `create()` the resolved value. Group fields with
  `x-group` and give every field a `title` and a `description`. The UI renders the form from these.
- Sources:
  - Event type ids are `<sourceId>.<object>.<verb>` (`github.pr.labeled`). Every event type
    declares a flat `attributes` schema (scalars or string arrays) and at least one example.
  - `verify` runs before `parse`, uses `verifyHmac` / `safeEqual` (constant time), and never
    throws. It returns `{ ok: false, reason }`.
  - `parse` is pure and deterministic. It does no I/O, reads no clock, and puts no secrets or raw
    body in attributes.
  - Build dedupe keys with `dedupeKey(type, artifact, deliveryId)`. Set `artifact.version` from the
    source's updated-at or etag when there is one.
  - `resolve` reads live state (no caching) and returns `null` on 404.
- Executors:
  - Declare `tracking`, `idempotentInvoke`, `usage` dimensions (with units) and `meters`
    truthfully. Provide `examples: [{ target, input }]` that validate against the schemas.
  - Let `HttpClient` throw `TransportError` for network failures. Map a backend refusal to
    `InvokeError` (`definitive: true` for a 4xx that will repeat, `status: 503` for retryable). Map
    a 429 to `InvokeResult.retryAfterSeconds`.
  - Report usage only in declared dimension ids. Never estimate per-run usage.
  - `verifyCallback` authenticates (HMAC or token) and returns `null` on anything doubtful.
- Tests: `src/plugin.test.ts` runs the full conformance kit plus behaviour tests against recorded
  fixtures in `src/__fixtures__/` and `createStubHttp` backends. No real network.
- Each plugin has a `README.md`: settings, event types or target/input, usage and meters, and
  the credential scopes it needs.
