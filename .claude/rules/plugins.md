---
paths:
  - 'plugins/**'
---

# Reference plugin conventions

- A plugin package is `plugins/<kind>-<name>/` named `@ai-switchboard/<kind>-<name>`. Its
  `package.json` has `"keywords": ["switchboard-plugin"]` and a `switchboard` field
  (`entry`, `source`, `sdk`), and the SDK is a peer dependency.
- `src/plugin.ts` default-exports `definePlugin({...})`. Every plugin uses the same layout:
  - `settings.ts`: the settings type and `settingsSchema`.
  - `schemas.ts`: re-exports `settingsSchema` (and `targetSchema` / `inputSchema` for a
    destination). It's published as `<package>/schemas` for the UI, so it and everything it
    imports must be browser-safe: no `node:` imports, no jsonata, and no value imports from the SDK
    root. Use `@ai-switchboard/sdk/schema` or `/json` for values, and `import type` from the root.
  - `api.ts`: the backend client (base URL, auth headers, requests, GraphQL documents, its error
    class). Token handling that outgrows it goes in `auth.ts` / `oauth.ts`.
  - Sources: `events.ts` (event type specs), `parse.ts` (pure `parseDelivery`), `actions.ts`
    (action specs and pure helpers) and `source.ts` (`create`: verify, resolve, act, health).
  - Destinations: `target.ts` (`targetSchema`, `inputSchema` and their types), `callback.ts` and
    `destination.ts`. Pure mapping of backend responses (run status, usage, meter readings) goes
    in its own module (`runs.ts`, `usage.ts`, `meters.ts`), separate from the HTTP calls.
  - Notifiers and secret providers: `notifier.ts` or `provider.ts`.
- Use the SDK helpers instead of writing your own: `withSettings` for `create`, the JSON
  narrowing helpers and `tryJson`, `errorText`, `verifyHmacHeader` / `verifySharedSecretHeader`,
  `headerValue`, `responseSnippet`, `checkHealth` (every `health`), `refusalFor`,
  `parseDefinitive` (targets and inputs), `dispatchAction` (for `act`), `meterReading`, the
  Switchboard protocol helpers (`readSignedJson`, `signSwitchboardBody`, `pickDeclaredUsage`,
  `verifySwitchboardCallback`, `callbackBodySchema`), `draftFromMapped` / `describeMappedDrop` /
  `toIsoTime`, `attr` / `flatAttributesSchema` for event attributes, and
  `@ai-switchboard/sdk/jsonata` for any JSONata evaluation (it enforces the expression limits).
  Backend quirks (a 529, a 403 rate limit) stay in the plugin as `refusalFor` hooks.
- Validate backend JSON with `tryParse` / `parseWith` or the narrowing helpers; never cast it.
- Declare `capabilities.network` with the exact hosts you call. Use `ctx.http` (the SDK's
  `HttpClient`), never raw `fetch`, so the capability check and tracing apply.
- Don't list `capabilities.secrets`: `definePlugin` derives it from the `x-secret` fields.
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
- Destinations:
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
