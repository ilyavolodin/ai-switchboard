# Plugin author guide

A plugin is an npm package that contributes source types, destination types, notifier types or
secret-provider types. Installing it registers it: its event types, settings forms, actions,
usage dimensions and meters appear in the UI without a line of code in the core. This guide
walks through the package format, the interfaces, and the conformance kit every plugin runs.

Everything here is exported by `@ai-switchboard/sdk` (and `@ai-switchboard/sdk/testing` for the
test kit). The SDK is the contract and follows semver strictly.

## Package format

```json
{
  "name": "@acme/ai-switchboard-source-deploys",
  "version": "1.2.0",
  "type": "module",
  "keywords": ["switchboard-plugin"],
  "files": ["dist"],
  "switchboard": {
    "entry": "./dist/plugin.js",
    "source": "./src/plugin.ts",
    "sdk": "^2.0.0"
  },
  "exports": { ".": { "types": "./dist/plugin.d.ts", "default": "./dist/plugin.js" } },
  "peerDependencies": { "@ai-switchboard/sdk": "^2.0.0" },
  "devDependencies": { "@ai-switchboard/sdk": "^2.0.0", "vitest": "^5.0.0" }
}
```

| Field                | Meaning                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `switchboard.entry`  | The built ES module whose default export is a `definePlugin()` result. Required                             |
| `switchboard.sdk`    | The SDK range the plugin supports. The host refuses to load a plugin whose range excludes the running major |
| `switchboard.source` | Optional TypeScript entry, used when the core runs with `SWITCHBOARD_DEV_SOURCE=true` under tsx             |
| `keywords`           | Include `switchboard-plugin` so the plugin can be found                                                     |
| `peerDependencies`   | `@ai-switchboard/sdk`, so the plugin shares the host's copy                                                 |

`switchboard plugins add` refuses a package without a `switchboard` field.

### Naming

Name the package so admins can find it from the UI (Plugins → Browse npm, and "Find more on npm"
in Add source / Add destination):

| Pattern                               | Example                                                    |
| ------------------------------------- | ---------------------------------------------------------- |
| `ai-switchboard-{kind}-{name}`        | `ai-switchboard-source-jira`                               |
| `@scope/ai-switchboard-{kind}-{name}` | `@acme/ai-switchboard-destination-n8n`                     |
| `@ai-switchboard/{kind}-{name}`       | `@ai-switchboard/source-webhook` (the project's own scope) |

`{kind}` is `source`, `destination`, `notifier` or `secrets` — the kind of types the package mainly
contributes. The pattern is `PLUGIN_NAME_PATTERN` in `packages/core/src/plugins/naming.ts`. Search
unions the name prefix with `keywords:switchboard-plugin` and shows only packages that match the
pattern, so keep the keyword too. A package with another name still installs by name with Add
plugin or `switchboard plugins add`.

## definePlugin

```typescript
import { definePlugin } from '@ai-switchboard/sdk';

import { deploysSource } from './source.js';
import { jobsDestination } from './destination.js';

export default definePlugin({
  id: 'acme-deploys', // globally unique, kebab-case
  displayName: 'Acme deploys',
  description: 'Deploy events from the Acme pipeline and the Acme job runner.',
  sources: [deploysSource],
  destinations: [jobsDestination],
  notifiers: [],
  secretProviders: [],
  capabilities: { network: ['api.acme.example', '*.jobs.acme.example'] },
});
```

`capabilities.secrets` (shown at install time) is derived from every settings field marked
`x-secret: true`, so you don't list it yourself. Since 2.1 a manually listed `secrets` is
deprecated; it is still merged into the derived list.

`validatePlugin(plugin)` returns the manifest problems the host would refuse: kebab-case unique
ids per kind, valid JSON Schemas, event types that start with the source type id, flat
attributes, examples that conform, at most one primary meter per destination type, and example
targets and inputs that validate, and well-formed icons.

### Icons

Every source, destination, notifier and secret provider type may declare an `icon` (since SDK
1.3). The UI shows it on instance cards and in the _Add_ dialogs; a type without one gets the
kind's generic icon.

- **A built-in name**: one of `ICON_NAMES` exported from `@ai-switchboard/sdk` (for example
  `'webhook'`, `'pr'`, `'issue'`, `'alert'`, `'run'`, `'play'`, `'link'`, `'refresh'`, `'key'`,
  `'lock'`). These are the UI's own 16 px stroke icons, so they match the rest of the interface
  in both themes. Prefer one when it fits.
- **Your own SVG**: a `data:image/svg+xml;base64,…` URI, at most 8 KB (8192 characters) in
  all, whose payload is an `<svg>` document. No other mime type, no URL-encoded form, no remote
  URLs. The UI draws it through `<img>`, never as inline markup, so scripts and external
  references inside the SVG don't run. Draw it on a 16×16 view box with a colour that reads on
  both light and dark backgrounds (`currentColor` does not apply inside `<img>`).

```typescript
import { readFileSync } from 'node:fs';

const icon = `data:image/svg+xml;base64,${readFileSync(new URL('../icon.svg', import.meta.url)).toString('base64')}`;

export const deploysSource: SourceType = {
  id: 'acme-deploys',
  displayName: 'Acme deploys',
  icon /* … */,
};
```

`validatePlugin` (and so the conformance kit's _manifest validates_ check) rejects an unknown
name, another mime type, invalid base64, a payload that isn't SVG, or a URI over the limit;
`iconProblem(icon)` gives the reason for one value.

## Settings schemas and UI annotations

Every type declares `settingsSchema` as JSON Schema draft 2020-12. The UI renders the form from
it, so a plugin never ships UI code. A few annotations steer the form:

| Annotation           | Effect                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-secret`           | The field holds a secret. The UI takes a `secret://<provider>/<name>` reference, never shows a value, and the core resolves it before `create`                                                                                            |
| `x-widget`           | Picks a control: `expression` (JSONata editor), `textarea`, `json`, `path` (1.4: a dotted path into a sample delivery, e.g. `body.issue.id`; the form suggests the paths of the sample a person pasted)                                   |
| `x-group`            | Groups fields under a heading                                                                                                                                                                                                             |
| `x-order`            | Orders fields within a group                                                                                                                                                                                                              |
| `x-placeholder`      | Placeholder text                                                                                                                                                                                                                          |
| `x-help`             | Longer help shown under the field                                                                                                                                                                                                         |
| `x-warning`          | `{ when: <JSON Schema>, message }` (or a list): a red warning under the field while its value matches `when`, e.g. `{ when: { const: 'none' }, message: 'Anyone who knows the URL can send events — evaluation only.' }`                  |
| `x-effectiveDefault` | 1.4: `[{ when?: <JSON Schema over the parent object>, value }]`: what the plugin does while the field is unset. The form shows it (and decides conditionals with it) but never writes it, unlike `default`, which the core stores on save |
| `x-docs`             | 1.4: `{ url, label? }`: a documentation link after the field's description (opens in a new tab)                                                                                                                                           |

```typescript
import type { JSONSchema } from '@ai-switchboard/sdk';

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['baseUrl', 'apiToken', 'webhookSecret'],
  properties: {
    baseUrl: {
      type: 'string',
      format: 'uri',
      title: 'API base URL',
      default: 'https://api.acme.example',
      'x-group': 'Connection',
    },
    apiToken: { type: 'string', title: 'API token', 'x-secret': true, 'x-group': 'Connection' },
    webhookSecret: {
      type: 'string',
      title: 'Webhook secret',
      description: 'The HMAC key Acme signs deliveries with.',
      'x-secret': true,
      'x-group': 'Webhook',
    },
  },
};
```

### Conditional fields

The form honours `if`/`then`/`else` (at the top level or inside `allOf`) and `dependentRequired`
for the current value. A property named by a branch — in its `properties` (a `true` schema is
enough) or its `required` — is shown only while a branch that names it applies, and the active
branches' `required` lists mark fields required. Properties no branch names are always shown.
The generic webhook uses this so `verification: none` hides the secret and header fields:

```typescript
allOf: [
  {
    if: { properties: { verification: { const: 'hmac' } } },
    then: {
      required: ['secret'],
      properties: { secret: { minLength: 1 }, signatureHeader: true, algorithm: true },
    },
  },
  {
    if: { properties: { verification: { const: 'shared_secret' } } },
    then: { required: ['secret'], properties: { secret: { minLength: 1 }, sharedSecretHeader: true } },
  },
],
```

A source type with `allowsUnauthenticated: true` may build an instance without `verify`; the core
then marks that instance unauthenticated (the red chip) — it is derived from the built instance, so
the plugin's own setting is the one switch. Flag that setting with `x-warning`. Types without
`allowsUnauthenticated` are refused when they build a push instance without `verify`.

`create(settings, ctx)` receives the settings with every `secret://` reference already resolved
to its value. Validate them and throw a named error when they are unusable; the instance then
shows the error and is not built. `parseWith(schema, settings, 'acme settings', { error:
AcmeSettingsError })` does this on a copy (so schema defaults are applied without mutating the
core's object) and throws `Invalid acme settings: …`. `tryParse(schema, value)` returns `null`
instead of throwing, for paths that must never throw. Both come from the SDK (1.2+).
`withSettings(schema, 'acme settings', createAcme, options?)` (2.1) wraps a `create` so it receives
the parsed, typed settings: `create: withSettings(settingsSchema, 'acme settings', createAcme)`.

A source whose event types are defined by the person configuring it (a generic webhook or poller)
can reuse the SDK's custom event type helpers: `eventTypeDefinitionSchema(sourceId, example)` for
the settings form, `compileEventTypes(sourceId, definitions)` for `eventTypesFor`, and
`narrowMapped(item, types)` to turn a mapping's output into a declared event. Since 2.1,
`draftFromMapped(mapped, { occurredAt, deliveryId?, fallbackDiscriminator? })` builds the
`EventDraft` and its dedupe key from that event, and `describeMappedDrop(item, types, index)` says
in plain language why `narrowMapped` returned `null`, for `parseWithNotes` and `PollResult.notes`. Since 1.4, a type
whose attribute names are only known per delivery declares `openAttributesSchema(properties?)`
(any extra key is accepted when its value is flat, so the core still refuses nested values), and
`flattenAttributes(body, { depth?, maxAttributes?, maxStringLength? })` turns an object into flat
attributes with filter-friendly keys (`deployment.id` → `deployment_id`, `attributeKey`). The
generic webhook's quick mode is built from these two.

A setting whose value the core must not fill in on save (because "unset" means something, like the
webhook's `mappingMode`: unset + a `mapping` = an instance from before the modes, which stays on
JSONata) leaves out `default` and declares `x-effectiveDefault` so the form still shows what
applies.

## Event types

Every event type a source can emit is declared up front:

```typescript
import type { EventTypeSpec } from '@ai-switchboard/sdk';

export const deployFinished: EventTypeSpec = {
  type: 'acme-deploys.deploy.finished', // '<source type id>.<object>.<verb>'
  title: 'Deploy finished',
  description: 'A deploy reached a terminal state.',
  attributes: {
    type: 'object',
    additionalProperties: false,
    properties: {
      service: { type: 'string', description: 'Service name' },
      environment: { type: 'string', enum: ['staging', 'production'] },
      status: { type: 'string', enum: ['success', 'failure'] },
      durationSeconds: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['service', 'environment', 'status'],
  },
  examples: [
    {
      service: 'api',
      environment: 'production',
      status: 'success',
      durationSeconds: 94,
      tags: ['team:core'],
    },
  ],
};
```

- **Naming:** `<source type id>.<object>.<verb>`, lower case: `github.pr.labeled`,
  `linear.issue.state_changed`, `datadog.monitor.triggered`.
- **Flat attributes:** every property is a string, number, integer, boolean or array of strings.
  Filters address them by name (`attributes.status = 'failure'`), and the filter editor lists
  them with their descriptions.
- **At least one example** per type, conforming to the schema. The editor shows examples while
  someone writes a filter.
- **Declared, not discovered.** The core validates every event against its declared schema.
  A non-conforming event is logged as `event_invalid`, counted against your plugin and never
  delivered, so a filter written against your documentation cannot be broken by an undocumented
  change.
- **References, not state.** Put facts in attributes and the thing in the `artifact`
  (`{ kind, id, url?, version? }`). The run re-reads real state. Never put a raw body, a token or
  personal data in an attribute.

## Dedupe keys

Every event carries `dedupeKey`, stable for the same change delivered twice and different for two
changes. Use the SDK helper:

```typescript
import { dedupeKey } from '@ai-switchboard/sdk';

// `${type}:${artifact.kind}:${artifact.id}:${artifact.version ?? deliveryId}`
const key = dedupeKey(type, artifact, deliveryId);
```

Where the system carries an object version (an `updatedAt`, an etag), set `artifact.version` so a
redelivery collapses and a new change does not. Where it does not (a monitor alert), use the
system's alert-cycle or delivery id. The core scopes the key per process, so two processes on the
same event each run once.

## Sources

```typescript
interface SourceType {
  id: string; // 'acme-deploys'
  displayName: string;
  mode: 'push' | 'pull' | 'both';
  settingsSchema: JSONSchema;
  eventTypes: EventTypeSpec[];
  actions?: ActionSpec[];
  create(settings: Settings, ctx: PluginContext): Source;
}

interface Source {
  verify?(req: RawRequest): VerifyResult; // push: authenticate before parse
  parse?(req: RawRequest): EventDraft[] | Promise<EventDraft[]>; // push: pure
  provision?(webhookUrl: string): Promise<ProvisionResult>; // push: register the webhook
  poll?(watermark: string | null): Promise<{ events: EventDraft[]; watermark: string }>; // pull
  resolve?(ref: ArtifactRef): Promise<ArtifactSnapshot | null>; // live state, never cached
  linked?(ref: ArtifactRef): Promise<ArtifactRef[]>;
  act?(action: string, args: unknown): Promise<ActionResult>;
  health(): Promise<Health>;
}
```

A push instance gets `/hooks/<sourceId>`. A pull instance is polled every `pollIntervalSeconds`
with its stored watermark. The core adds `enabled`, event caps, the mute list and the poll
interval to every instance; don't put them in your schema.

### Example: a signed push source

```typescript
import {
  checkHealth,
  dedupeKey,
  verifyHmacHeader,
  withSettings,
  type EventDraft,
  type PluginContext,
  type RawRequest,
  type Source,
  type SourceType,
} from '@ai-switchboard/sdk';

import { deployFinished } from './event-types.js';
import { settingsSchema } from './settings.js';

interface DeploysSettings {
  baseUrl: string;
  apiToken: string;
  webhookSecret: string;
}

interface DeployBody {
  deployment: { id: string; url: string; updated_at: string };
  service: string;
  environment: 'staging' | 'production';
  status: 'success' | 'failure';
  duration_seconds?: number;
  tags?: string[];
  finished_at: string;
}

function createDeploysSource(settings: DeploysSettings, ctx: PluginContext): Source {
  return {
    // HMAC of the exact bytes received; a missing header or a mismatch returns a reason.
    verify: (req: RawRequest) =>
      verifyHmacHeader(req, {
        header: 'x-acme-signature',
        secret: settings.webhookSecret,
        prefix: 'sha256=',
      }),

    // Pure and deterministic: no I/O, no clock, no randomness.
    parse(req: RawRequest): EventDraft[] {
      const body = JSON.parse(req.body.toString('utf8')) as DeployBody;
      const type = deployFinished.type;
      const artifact = {
        kind: 'acme.deploy',
        id: body.deployment.id,
        url: body.deployment.url,
        version: body.deployment.updated_at,
      };
      const deliveryId = req.headers['x-acme-delivery'];
      return [
        {
          type,
          occurredAt: body.finished_at,
          artifact,
          attributes: {
            service: body.service,
            environment: body.environment,
            status: body.status,
            ...(body.duration_seconds !== undefined
              ? { durationSeconds: body.duration_seconds }
              : {}),
            tags: body.tags ?? [],
          },
          dedupeKey: dedupeKey(type, artifact, deliveryId),
          ...(deliveryId !== undefined ? { deliveryId } : {}),
        },
      ];
    },

    async resolve(ref) {
      const res = await ctx.http.get(`${settings.baseUrl}/deployments/${ref.id}`, {
        headers: { authorization: `Bearer ${settings.apiToken}` },
      });
      if (res.status === 404) return null;
      return { ref, ...res.json<Record<string, unknown>>() };
    },

    // checkHealth stamps checkedAt and turns a throw into `unhealthy`.
    health: () =>
      checkHealth(ctx, async () => {
        const res = await ctx.http.get(`${settings.baseUrl}/ping`);
        return { status: res.ok ? 'healthy' : 'unhealthy' };
      }),
  };
}

export const deploysSource: SourceType = {
  id: 'acme-deploys',
  displayName: 'Acme deploys',
  mode: 'push',
  settingsSchema,
  eventTypes: [deployFinished],
  create: withSettings(settingsSchema, 'acme-deploys settings', createDeploysSource),
};
```

### The verify and parse contract

- `verify` runs before `parse` and rejects anything it has not authenticated: a missing header, a
  wrong signature, and (where the system sends one) a timestamp outside the allowed skew. It
  returns `{ ok: false, reason }` and never throws. `verifyHmacHeader(req, { header, secret,
prefix?, algorithm?, encoding? })` and `verifySharedSecretHeader(req, { header, secret })` (2.1)
  do the header lookup, the constant-time comparison and the reason (`missing <header> header`,
  `signature mismatch`, `secret mismatch`). `verifyHmac` and `safeEqual` remain for anything else.
- The core answers a rejected delivery with an empty 401 and logs the reason with the remote
  address. Your `reason` never reaches the sender.
- `parse` is pure and deterministic: one delivery gives 0..n events, the same bytes give the same
  events. It may be `async` (JSONata evaluation is), but it does no I/O and reads no clock.
- Return an empty array for deliveries you don't turn into events (a ping, an unsubscribed
  action). Throwing counts as a plugin error.
- Optionally (1.4) implement `parseWithNotes(req)` → `{ events, notes }`: the same events as
  `parse`, plus plain-language notes on what produced no event and why ("no rule matched:
  `headers.x-event-type` is `issue.updated`"). The Add source dialog and the Settings tab of every
  push source have a _Try it with a sample delivery_ panel (`POST /api/v1/sources/preview`): it
  builds a throwaway instance from the draft settings, runs the pasted sample through
  `parseWithNotes` (or `parse`) — never `verify` — and shows the events, the core's validation of
  them, and your notes. Notes must not contain a secret or the raw body; the conformance kit
  checks both and that the events match `parse`.
- `resolve` reads live state, never a cache: the filters that need it are exactly the ones a stale
  answer breaks. Return `null` for a 404.
- A source type without `verify` is refused for anything but the generic `webhook` source's
  explicit evaluation mode.

## Destinations

```typescript
interface DestinationType {
  id: string;
  displayName: string;
  settingsSchema: JSONSchema; // per instance: credentials, base URL
  targetSchema: JSONSchema; // per process: what to run
  inputSchema: JSONSchema; // what the process's input mapping must produce
  examples?: { target: unknown; input: unknown }[];
  tracking: 'sync' | 'poll' | 'callback' | 'none';
  trackingFor?(target: unknown): TrackingMode; // when the mode depends on the target
  idempotentInvoke: boolean;
  idempotentFor?(target: unknown): boolean;
  invokeTimeoutSeconds?: number; // since 1.3: how long invoke may take to answer (default 300 s)
  invokeTimeoutFor?(target: unknown): number | undefined; // since 1.3: per target
  usage: UsageDimension[];
  usageFor?(settings: Settings): UsageDimension[];
  meters?: MeterSpec[];
  metersFor?(settings: Settings): MeterSpec[];
  actions?: ActionSpec[];
  create(settings: Settings, ctx: PluginContext): Destination;
}

interface Destination {
  invoke(target: unknown, input: unknown, run: RunHandle): Promise<InvokeResult>;
  poll?(run: RunHandle): Promise<RunStatus>; // tracking = 'poll'
  verifyCallback?(req: RawRequest): { runId: string; status: RunStatus } | null; // 'callback'
  readMeters?(): Promise<MeterReading[]>;
  act?(action: string, args: unknown): Promise<ActionResult>;
  health(): Promise<Health>;
}
```

`RunHandle` carries the core's run `id` (echo it to the backend so callbacks and correlation
work), `mode` (`event`, `sweep` or `manual`), `dryRun`, `callbackUrl` and the tracking `deadline`.

### Tracking modes

| Mode       | `invoke` returns                                   | How the run closes                                                                                                            |
| ---------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sync`     | `completed` or `failed`, with `result` and `usage` | At once                                                                                                                       |
| `poll`     | `started` with `externalId`                        | The core calls `poll(run)` on a backoff (30 s, 1, 2, 5 min, then every 5 min) until a terminal state or the deadline          |
| `callback` | `started` with `externalId`                        | The backend POSTs to `run.callbackUrl` (`/callbacks/<destinationId>`); `verifyCallback` authenticates it and maps it to a run |
| `none`     | `started`                                          | A 2xx closes the run `ok`; the UI says the outcome is not tracked                                                             |

A run still open at its deadline becomes `unknown`, which counts toward the process's breaker.
`status: 'held'` with a `reason` means the backend refused because the target is paused on its
side. `retryAfterSeconds` means it is out of capacity, and the core opens a soft-hold on the
instance for that long.

### Idempotency and errors

`idempotentInvoke` is the one flag that keeps a metered backend from being charged twice by a
flaky network. Declare it honestly:

- `true`: the backend deduplicates on the run id. The core may retry an invoke whose response was
  lost, with the same run id.
- `false`: a request that may have reached the backend (timeout, connection reset, 5xx after
  send) leaves the run `uncertain`. The core never calls `invoke` again; tracking settles the run
  or the deadline marks it `unknown`.

Only two failures are retried for a non-idempotent destination: a connection that was never
established, and a 503. Tell the core which one happened:

- `ctx.http` throws `TransportError` with `sent: false` when nothing was sent (connection refused,
  DNS failure) and `sent: true` when the request may have arrived (timeout after connect, reset).
  Let it propagate.
- Throw `InvokeError` for a backend answer: `{ status: 503 }` may be retried,
  `{ definitive: true }` (a 4xx the backend will repeat, such as a bad target) fails the run, and
  anything else is `uncertain` when not idempotent. `invokeErrorForStatus(status, message)` builds
  the right one from an HTTP status.
- Return `{ status: 'failed', retryAfterSeconds }` for a 429: the request was refused, nothing
  ran, and `retryAfterSeconds` opens the soft-hold.

`refusalFor(res, now, options)` (2.1) applies all of these to a non-2xx response: a rate limit
(429 by default) returns `failed` with `retryAfterSeconds` from `retry-after`, else
`DEFAULT_RETRY_AFTER_SECONDS` (60); a `held` hook's reason returns `held`; anything else throws
`invokeErrorForStatus`. Backend quirks are hooks: `isRateLimited` (GitHub's 403 with
`x-ratelimit-remaining: 0`), `retryAfterSeconds` (a reset header), `retryableStatuses` (Anthropic's
529 is treated as a 503), `rateLimitMessage`.

```typescript
if (!res.ok)
  return refusalFor(res, ctx.now(), {
    message: (r) => `jobs answered ${r.status}`,
    held: (r) => (r.status === 423 ? 'paused' : undefined),
  });
```

Guards `isTransportError`, `isInvokeError`, `isCapabilityError` and `isSecretNotFoundError` are
duck-typed, so they work across duplicate SDK copies.

### Invoke timeout

The core waits a limited time for `invoke` to answer. The effective timeout is, in order: the
destination's `invokeTimeoutSeconds` cap (set by an admin in the UI), else the type's
`invokeTimeoutFor(target)`, else the type's `invokeTimeoutSeconds`, else 300 s. It is clamped to
1–3600 s.

No answer in time is a **lost response, not a plugin error**: the request may have reached the
backend, so the idempotency rule applies. An idempotent invoke is retried with the same run id; a
non-idempotent one leaves the run `uncertain` for tracking to settle, never a second `invoke`.
The timeout is not counted against the plugin.

The timeout also tells recovery when an attempt is stale. Each attempt records a deadline (the
`before` steps' budget, the invoke timeout and a 30 s margin), and a replica that finds a run
still `invoking` leaves it alone until that deadline has passed. So declare a timeout that
covers what `invoke` really does:

- One HTTP request: the `HttpClient` timeout (30 s by default) plus room to read the answer, for
  example `invokeTimeoutSeconds: 60`.
- Several requests in one invoke (a token exchange, then the dispatch, then a lookup): the sum.
- A timeout the target chooses (the `http` destination's `timeoutSeconds`): implement
  `invokeTimeoutFor(target)` and return the request timeout plus a margin.

Keep your own request timeouts **below** the invoke timeout, so a slow backend surfaces as your
`TransportError` (with its accurate `sent` flag) before the core gives up on the answer.

### Example: a destination with callback tracking

```typescript
import {
  checkHealth,
  pickDeclaredUsage,
  readSignedJson,
  refusalFor,
  SWITCHBOARD_RUN_ID_HEADER,
  tryParse,
  withSettings,
  type CallbackResult,
  type DestinationType,
  type PluginContext,
  type RawRequest,
  type RunHandle,
} from '@ai-switchboard/sdk';

interface JobsSettings {
  baseUrl: string;
  apiToken: string;
  callbackSecret: string;
}
interface JobsTarget {
  queue: string;
}
interface JobsCallback {
  runId: string;
  status: 'ok' | 'error';
  usage?: Record<string, unknown>;
  finishedAt?: string;
}

const settingsSchema = {
  type: 'object',
  required: ['baseUrl', 'apiToken', 'callbackSecret'],
  properties: {
    baseUrl: { type: 'string', format: 'uri', title: 'Base URL', description: 'Acme API root.' },
    apiToken: { type: 'string', 'x-secret': true, title: 'API token', description: 'Bearer.' },
    callbackSecret: {
      type: 'string',
      'x-secret': true,
      title: 'Callback secret',
      description: 'Signs the run callbacks.',
    },
  },
};

const callbackSchema = {
  type: 'object',
  required: ['runId', 'status'],
  properties: {
    runId: { type: 'string' },
    status: { enum: ['ok', 'error'] },
    usage: { type: 'object' },
    finishedAt: { type: 'string', format: 'date-time' },
  },
};

const DECLARED = new Set(['tokens']);

function createJobsDestination(s: JobsSettings, ctx: PluginContext) {
  const auth = { authorization: `Bearer ${s.apiToken}` };

  return {
    async invoke(target: unknown, input: unknown, run: RunHandle) {
      const { queue } = target as JobsTarget; // validated against targetSchema by the core
      // TransportError from ctx.http propagates: the core reads `sent` to decide.
      const res = await ctx.http.post(`${s.baseUrl}/queues/${queue}/jobs`, {
        headers: { ...auth, [SWITCHBOARD_RUN_ID_HEADER]: run.id },
        json: { input, runId: run.id, callbackUrl: run.callbackUrl, dryRun: run.dryRun },
      });
      // 429 → failed with retryAfterSeconds; 503 may be retried; another 4xx is definitive.
      if (!res.ok)
        return refusalFor(res, ctx.now(), { message: (r) => `jobs answered ${r.status}` });
      const body = res.json<{ id: string; url: string }>();
      return { status: 'started' as const, externalId: body.id, externalUrl: body.url };
    },

    verifyCallback(req: RawRequest): CallbackResult | null {
      // `x-switchboard-signature: sha256=<hex>` over the raw body; undefined when unsigned or not JSON.
      const body = tryParse<JobsCallback>(callbackSchema, readSignedJson(req, s.callbackSecret));
      if (!body) return null; // the core answers an empty 401
      const usage = pickDeclaredUsage(body.usage, DECLARED);
      return {
        runId: body.runId,
        status: {
          state: body.status,
          ...(usage ? { usage } : {}),
          ...(body.finishedAt !== undefined ? { finishedAt: body.finishedAt } : {}),
        },
      };
    },

    async readMeters() {
      const res = await ctx.http.get(`${s.baseUrl}/quota`, { headers: auth });
      const q = res.json<{ used: number; limit: number; resetsAt: string }>();
      return [
        {
          id: 'daily_jobs',
          used: q.used,
          limit: q.limit,
          utilization: q.limit > 0 ? Math.min(100, (100 * q.used) / q.limit) : 0,
          resetsAt: q.resetsAt,
          observedAt: ctx.now().toISOString(),
        },
      ];
    },

    health: () =>
      checkHealth(ctx, async () => {
        const res = await ctx.http.get(`${s.baseUrl}/ping`, { headers: auth });
        return { status: res.ok ? 'healthy' : 'unhealthy' };
      }),
  };
}

export const jobsDestination: DestinationType = {
  id: 'acme-jobs',
  displayName: 'Acme jobs',
  settingsSchema,
  targetSchema: {
    type: 'object',
    required: ['queue'],
    additionalProperties: false,
    properties: { queue: { type: 'string', minLength: 1, title: 'Queue' } },
  },
  inputSchema: {
    type: 'object',
    required: ['runId', 'mode'],
    properties: {
      runId: { type: 'string' },
      mode: { enum: ['event', 'sweep', 'manual'] },
      artifacts: { type: 'array' },
    },
  },
  examples: [{ target: { queue: 'triage' }, input: { runId: 'r1', mode: 'event', artifacts: [] } }],
  tracking: 'callback',
  idempotentInvoke: false,
  usage: [{ id: 'tokens', title: 'Tokens', unit: 'tokens', aggregate: 'sum', budgetable: true }],
  meters: [
    { id: 'daily_jobs', title: 'Daily jobs', kind: 'allowance', unit: 'count', primary: true },
  ],
  create: withSettings(settingsSchema, 'acme-jobs settings', createJobsDestination),
};
```

### Usage and meters

**Usage** is what one run consumed. Declare the dimensions once (`id`, `title`, `unit`,
`aggregate: 'sum' | 'max'`, `budgetable`) and report a `UsageReport` keyed by those ids: in the
`InvokeResult` for sync destinations, in the `RunStatus` from `poll` or `verifyCallback` for the
rest. The core drops (and counts against your plugin) any undeclared key, aggregates usage into
hourly statistics, enforces per-process daily caps on budgetable dimensions, and renders each one
with its unit. Report nothing rather than a guess: the core never estimates per-run usage.
Destinations whose dimensions depend on the instance (the `http` destination) implement `usageFor`.

**Meters** are the backend's remaining capacity, read on a schedule through `readMeters()`:

| Kind        | Example                          |
| ----------- | -------------------------------- |
| `window`    | A rolling five-hour usage window |
| `allowance` | Runs per day                     |
| `spend`     | Dollars this month               |

A reading carries `utilization` 0–100, optional `used`/`limit`, `resetsAt` and `observedAt`.
Processes set ceilings per meter id (`{ events: 85, sweeps: 95 }`), and the budget stage checks
the latest fresh reading. Mark at most one meter `primary`: it is the gauge in the top bar.

A meter the backend cannot report can declare `estimate: { period: 'day' | 'hour' | 'week',
defaultLimit? }`. The core then estimates it from its own run counts against a limit the person
types in (`caps.estimatedLimits`), and the UI labels it _estimated_.

## Actions

Sources and destinations can declare actions (`ActionSpec`: `id`, `title`, `argsSchema`, an
optional `describe` sentence such as `Add label {{label}}`, and since 1.3 `idempotent`) and
implement `act(action, args)`. Processes use them as `before` and `after` steps. The core
validates `args` against `argsSchema` before calling, records every call in `steps` with the run
that caused it, and fails the run if a `before` step fails. Return `{ ok, message?, data? }`.
Document the credential scope each action needs.

### Idempotent actions

The core keeps a journal of steps: each step's row is written `started` before `act` is called
and settled (`ok` or `error`) after. When a replica dies between the two, the step is **in
doubt**: the action may or may not have happened. What the core does next depends on
`idempotent` (default `false`):

- `idempotent: true`: repeating the action is harmless whether or not the first attempt
  happened (add a label, remove a label, set a state, mark a pull request ready). The core runs
  it again.
- `idempotent: false`: repeating it would duplicate a side effect (post a comment, send a
  message). A `before` step in doubt fails the run with
  `step_in_doubt:before[<index>] <action>` before anything is invoked; an `after` step in doubt
  is recorded `uncertain` and the remaining steps still run.

Steps that settled are never repeated, and a step that never started runs on resume. Declare
`idempotent: true` only when a second call leaves the same state as one call:

```typescript
actions: [
  { id: 'addLabel', title: 'Add label', argsSchema, idempotent: true },
  { id: 'comment', title: 'Comment', argsSchema }, // not idempotent: a second call posts twice
],
```

## HttpClient and capabilities

`ctx.http` is the only HTTP client a plugin should use:

- It honours the plugin's declared `capabilities.network` host globs (`api.github.com`,
  `*.atlassian.net`, `*`). A request to any other host throws `CapabilityError` before anything
  is sent.
- It propagates the trace context, so your outbound call appears in the event's trace.
- It throws `TransportError` with an accurate `sent` flag, which the idempotency rule depends on.
- It has a 30-second default timeout (`timeoutMs` per request) covering every redirect hop and
  the response body.
- It follows redirects itself (at most five) and checks every hop against the declared hosts. On a
  redirect to another origin it forwards only harmless headers (`accept*`, `content-type`,
  `user-agent`, trace context), so a credential in any header, not just `authorization`, stays
  with the origin it was meant for.

`capabilities.secrets` lists the settings fields marked `x-secret`; `definePlugin` derives it, and
both lists are shown to the admin at install time. A plugin that calls raw `fetch` or opens sockets bypasses
the network check; plugins are trusted code, and the capability list is a promise the reviewer
checks.

Responses are narrowed from `unknown` with the SDK's JSON helpers (2.1, also browser-safe at
`@ai-switchboard/sdk/json`): `tryJson(res)` (the body, or `undefined` when it is empty or not
JSON), `isRecord`, `asObject`, `asString`, `asNumber` (finite only), `asBoolean`, `asArray` (`[]`
for a non-array), `getPath(value, ...keys)` and `parseJsonObject(text)`.

The Switchboard wire protocol has helpers too: `SWITCHBOARD_SIGNATURE_HEADER`
(`x-switchboard-signature: sha256=<hex>`), `signSwitchboardBody(secret, body)`,
`verifySwitchboardSignature(req, secret)`, `readSignedJson(req, secret)` (the verified JSON body,
or `undefined`), `pickDeclaredUsage(usage, declaredIds)` and `SWITCHBOARD_RUN_ID_HEADER`
(`x-switchboard-run-id`).

`createHttpClient`, `hostMatches`, `makeResponse` and `isPluginDefinition` are for the plugin host
and live at `@ai-switchboard/sdk/host` since 2.1; their root exports are deprecated.

Also on `ctx`: `logger` (structured, never log secrets), `now()` (use it instead of `Date.now()`),
`publicUrl`, `instanceId`, `instanceName`, `state` and `secrets`.

### Instance state and rotated credentials

`ctx.state` is a small durable key/value store per instance (a cursor, a watermark, when a token
expires). It is a Postgres row, so it must never hold a credential. The host refuses a value that
carries one it knows about (any resolved setting, or anything that went through `ctx.secrets`) with
`SecretInStateError`.

A credential the instance **rotates** at run time, such as an OAuth refresh token the token endpoint
replaces on every refresh, goes to `ctx.secrets` (SDK 2.2):

```typescript
interface InstanceSecrets {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  check(): Promise<{ writable: true; provider: string } | { writable: false; reason: string }>;
}
```

- Keys match `SECRET_KEY_PATTERN` (lower-case letters, digits, `-` and `_`, at most 64).
- The host stores the value in the first **writable** secret provider that the instance's settings
  already reference, so the rotated value lives next to the seed it came from. It uses the name
  `switchboard-<instance id>-<key>`. Only the host maps keys to provider names.
- If no referenced provider is writable, `set` and `delete` throw `SecretStoreError` and `get`
  returns `undefined`. The host never falls back to Postgres. Call `check()` before you spend a
  single-use token, and report its `reason` from `health()` so the instance shows unhealthy and
  `switchboard doctor` fails.
- When the instance is deleted, the host deletes what it stored.

Keep only non-secret metadata in `ctx.state` (the seed's fingerprint, an expiry). The
`destination-claude-routines` seat meters are the reference: rotated refresh and access tokens in
`ctx.secrets`, `{ seed, expiresAt }` in `ctx.state`. Their `health()` is unhealthy when the store
is not writable. In tests, `createMemorySecrets(initial, { writable })` from
`@ai-switchboard/sdk/testing` stands in, and `createTestContext({ secrets })` takes it.

## Notifiers and secret providers

```typescript
interface NotifierType {
  id: string;
  displayName: string;
  settingsSchema: JSONSchema;
  create(
    settings: Settings,
    ctx: PluginContext,
  ): { send(message: NotificationMessage): Promise<void>; health(): Promise<Health> };
}

interface SecretProviderType {
  id: string;
  displayName: string;
  settingsSchema: JSONSchema;
  create(
    settings: Settings,
    ctx: PluginContext,
  ): {
    resolve(name: string): Promise<string>;
    health(): Promise<Health>;
    /** Optional (SDK 1.1+). Names only, never values. */
    list?(): Promise<{ name: string; description?: string; updatedAt?: string }[]>;
    /** Optional (SDK 2.2+), always together: a writable provider. */
    set?(name: string, value: string): Promise<void>;
    delete?(name: string): Promise<void>;
  };
}
```

A notifier receives `{ on, severity, title, text, url?, fields? }` for process notifications
(`ok`, `error`, `held`, `throttled`) and system alerts (`system`). A secret provider resolves
`secret://<provider instance name>/<name>` to a value, and throws when the secret does not exist.
Values it returns live only in the built instance's memory.

A provider that can enumerate what it holds implements the optional `list()` (SDK 1.1). It returns
secret **names only**: never a value, and nothing derived from one (no length, prefix, hash or
preview) in any field. Admins see the names under Settings › Secret providers, together with
which instances use each one and which references point at names the provider does not list.
Return only names `resolve` would accept. Omit `list()` if the backend cannot enumerate.

A provider that can store values implements `set` and `delete` together (SDK 2.2). The host
uses them only for `ctx.secrets`, the credentials instances rotate. `set` creates or replaces a
value atomically (a reader sees the old value or the new one, never a mix). `delete` of a missing
name succeeds. Neither ever puts the value in an error message or a log line.
`isWritableSecretProvider(provider)` tells the two kinds apart. The conformance kit checks that
`set` and `delete` come together, that they round-trip through `resolve` (a deleted name throws
`SecretNotFoundError`), and that a write never leaks the value into an error or `ctx.logger`.
`writableName` in the fixtures picks the name the probe uses. A provider backed by something
read-only (environment variables, a read-only mount) leaves both out.

## The conformance kit

Every reference plugin runs the conformance kit in its `src/plugin.test.ts`, and so should yours.
The checks encode the contracts above:

- **Plugin** (`pluginConformanceChecks(plugin, fixtures?)`): the manifest validates. With
  `fixtures` (2.1: `{ sources?, destinations?, notifiers?, secretProviders? }`, each keyed by type
  id, plus `settings: { notSecret? }`), it also runs every type's settings-form checks and, for
  each type with fixtures, that type's checks with `capabilities.network` enforced, and finishes
  with _calls only the hosts in capabilities.network_, which catches a `CapabilityError` your code
  swallowed. This is the one call a plugin test needs.
- **Settings** (`settingsSchemaChecks(schema, { notSecret? })`): every field, nested ones too, has
  a `title` and a `description`; every credential-looking field (`…token`, `…secret`,
  `…password`, `apiKey`, `privateKey`, …) is marked `x-secret`.
- **Source:** manifest validates; every event type has a schema and an example; `health()`
  resolves; `verify` accepts signed deliveries and rejects a wrong signature, a missing header
  and a stale timestamp; `parse` is deterministic and its events validate; `dedupeKey` is equal
  for the same change and different across changes; no attribute contains the raw body or a
  secret; `parseWithNotes`, when present, returns `parse`'s events and notes without the raw body
  or a secret; `resolve` handles a 404; `poll` advances the watermark and never re-emits.
- **Destination:** manifest validates; `targetSchema` and `inputSchema` are valid with examples;
  `idempotentInvoke` is declared; the tracking mode's method exists; `invoke` with the example
  target and input against your stub returns a well-formed `InvokeResult`; `verifyCallback`
  rejects an unsigned request; `readMeters` returns readings for the declared meters; every usage
  dimension has a unit and reported usage uses declared ids only.
- **Notifier** (`notifierConformanceChecks(type, { settings, http?, message? })`, 2.1): manifest
  validates; `health()` resolves; `send` makes at least one request for a message; `send` rejects
  when the backend answers 500, so the core records the failure.
- **Secret provider** (`secretProviderConformanceChecks(type, { settings, expectNames?, secrets? })`):
  manifest validates; `health()` resolves; `list()`, when implemented, returns unique non-empty
  names with only `name` / `description` / `updatedAt`; and no value `resolve` returns for a
  listed name (or any value in `secrets`) appears anywhere in the listing.

```typescript
// src/plugin.test.ts
import { readFileSync } from 'node:fs';

import { signHmac } from '@ai-switchboard/sdk';
import {
  pluginConformanceChecks,
  rawRequest,
  runConformance,
  type DestinationFixtures,
  type SourceFixtures,
} from '@ai-switchboard/sdk/testing';
import { describe, expect, it } from 'vitest';

import plugin, { deploysSource, jobsDestination } from './plugin.js';

const SECRET = 'fixture-secret';

function delivery(file: string, headers: Record<string, string> = {}) {
  const body = readFileSync(new URL(`./__fixtures__/${file}`, import.meta.url));
  return rawRequest({
    body,
    headers: {
      'content-type': 'application/json',
      'x-acme-signature': `sha256=${signHmac({ secret: SECRET, payload: body })}`,
      ...headers,
    },
  });
}

const deploysFixtures: SourceFixtures = {
  settings: {
    baseUrl: 'https://api.acme.example',
    apiToken: 'fixture-token',
    webhookSecret: SECRET,
  },
  secrets: [SECRET, 'fixture-token'],
  http: (req) => (req.url.pathname === '/ping' ? { status: 200, json: { ok: true } } : undefined), // anything else is a 404
  push: {
    deliveries: [delivery('deploy-finished.json'), delivery('deploy-failed.json')],
    sameChange: [
      delivery('deploy-finished.json', { 'x-acme-delivery': 'd-1' }),
      delivery('deploy-finished.json', { 'x-acme-delivery': 'd-2' }),
    ],
    differentChange: [delivery('deploy-finished.json'), delivery('deploy-finished-later.json')],
    wrongSignature: {
      ...delivery('deploy-finished.json'),
      headers: { 'x-acme-signature': 'sha256=00' },
    },
    missingHeader: rawRequest({
      body: readFileSync(new URL('./__fixtures__/deploy-finished.json', import.meta.url)),
    }),
  },
  resolveNotFound: { kind: 'acme.deploy', id: 'missing' },
};

const jobsFixtures: DestinationFixtures = {
  settings: {
    baseUrl: 'https://jobs.acme.example',
    apiToken: 'fixture-token',
    callbackSecret: SECRET,
  },
  http: (req) => {
    if (req.url.pathname === '/queues/triage/jobs')
      return { status: 201, json: { id: 'job-1', url: 'https://jobs.acme.example/job-1' } };
    if (req.url.pathname === '/quota')
      return { json: { used: 3, limit: 20, resetsAt: '2026-09-28T00:00:00Z' } };
    if (req.url.pathname === '/ping') return { json: { ok: true } };
    return undefined;
  },
  unsignedCallback: rawRequest({ body: { runId: 'r1', status: 'ok' } }),
};

runConformance(
  'acme-deploys plugin',
  pluginConformanceChecks(plugin, {
    sources: { [deploysSource.id]: deploysFixtures },
    destinations: { [jobsDestination.id]: jobsFixtures },
  }),
  { describe, it },
);

describe('acme-jobs destination', () => {
  it('maps a 400 to a definitive failure', async () => {
    // plugin-specific tests go here, next to the conformance checks
    expect(jobsDestination.idempotentInvoke).toBe(false);
  });
});
```

Fixture secrets are obviously fake (`fixture-secret`), and fixtures live in `src/__fixtures__/`.
`createStubHttp`, `createTestContext`, `rawRequest` and `runHandle` from the testing kit help
with plugin-specific tests.

### Recording fixtures

Real deliveries make the best fixtures. Capture one (from a source's event page raw view, or a
proxy) and scrub it before committing:

```typescript
import { writeFileSync } from 'node:fs';

import { signHmac } from '@ai-switchboard/sdk';
import { scrubRequest } from '@ai-switchboard/sdk/testing';

const recorded = scrubRequest(realRequest, {
  secrets: [realWebhookSecret, realApiToken],
  dropHeaders: ['authorization', 'cookie'],
  // Re-sign the scrubbed body with the fixture secret so it still verifies in tests.
  resign: (body) => ({
    'x-acme-signature': `sha256=${signHmac({ secret: 'fixture-secret', payload: body })}`,
  }),
});
writeFileSync('src/__fixtures__/deploy-finished.json', JSON.stringify(recorded, null, 2));
```

`deserializeRequest(recorded)` turns the JSON back into a `RawRequest`. Never commit a fixture
with a real token.

## Development loop

1. Build or link your package into a directory the core scans:
   `SWITCHBOARD_PLUGIN_DIRS=/path/to/your/workspace/node_modules`, or
   `switchboard plugins add file:/path/to/your/package --home ./.switchboard`.
2. Run the core from source with your TypeScript entry:
   `SWITCHBOARD_DEV_SOURCE=true pnpm dev`. The host imports `switchboard.source` instead of
   `switchboard.entry`.
3. Restart after changing the manifest. Settings changes to an instance rebuild only that
   instance.
4. The Plugins page shows load errors, the error count attributed to your plugin and invalid
   events. `switchboard doctor` runs every instance's `health()`.

## Publishing

- Publish to npm (or a private registry; installs honour `.npmrc`) with `keywords:
["switchboard-plugin"]`, `@ai-switchboard/sdk` as a peer dependency and the `switchboard` field
  with `entry` and `sdk`.
- Ship built JavaScript in `files`. The host imports `switchboard.entry` directly.
- Document the credentials and scopes each action needs, the capabilities you declare and why,
  and how usage numbers are obtained.
- Admins install from the UI (Plugins → Browse npm, or "Find more on npm" when adding a source or
  destination), which shows your capabilities and SDK compatibility, pins the exact version and
  integrity, and loads the plugin at once on every replica. For images, `switchboard plugins add
@acme/ai-switchboard-source-deploys@^1` does the same at build time.
- To be listed in the catalogue of reviewed plugins, open an issue on the Switchboard repository
  with a link to your package and a passing conformance run.

## Semver policy

- `@ai-switchboard/sdk` follows semver strictly. Additive fields are minor releases; any change
  to an interface method is a major.
- The host loads any plugin whose `switchboard.sdk` range includes the running SDK major. Declare
  `^2.0.0` and you will load on every 2.x host. The host checks the full range, so if you use an
  export added in a later 2.x minor, declare that minor in both `switchboard.sdk` and
  `peerDependencies`. An older host ignores the optional fields.
- SDK 2.0.0 renamed the "executor" concept to **destination** (`DestinationType`, `Destination`,
  `definePlugin({ destinations })`, `destinationConformanceChecks`, plugin kind `destination`).
  The plugin contract changed, so a plugin built against SDK 1.x is reported `incompatible` and
  is not loaded: rebuild it against `^2.0.0`. Everything that arrived during 1.x (`parseWith`,
  `invokeErrorForStatus`, the custom event type helpers, `icon`, `ICON_NAMES`,
  `invokeTimeoutSeconds`, `invokeTimeoutFor`, `ActionSpec.idempotent`, `Source.parseWithNotes`,
  `openAttributesSchema`, `flattenAttributes`, `attributeKey`, `x-effectiveDefault`, `x-docs`,
  `x-widget: 'path'`) is part of 2.0.0.
- SDK 2.1.0 is additive: the JSON helpers and `tryJson`, `refusalFor`, `verifyHmacHeader`,
  `verifySharedSecretHeader`, the Switchboard protocol helpers, `checkHealth`, `withSettings`,
  `draftFromMapped`, `describeMappedDrop`, `PollResult.notes`, `SecretNotFoundError`,
  `isSecretNotFoundError`, `isCapabilityError`, the `/host` and `/json` subpaths, the custom event
  schema helpers on `/schema`, `notifierConformanceChecks`, `settingsSchemaChecks` and
  `pluginConformanceChecks(plugin, fixtures)`. Deprecated (still exported until 3.0): a manually
  listed `capabilities.secrets`, and the root exports of `createHttpClient`, `hostMatches`,
  `makeResponse`, `isPluginDefinition` and `HttpClientOptions` (import them from
  `@ai-switchboard/sdk/host`).
- SDK 2.2.0 is additive: `ctx.secrets` (`InstanceSecrets`, `SecretStoreStatus`), the optional
  `SecretProvider.set` and `delete`, `SecretStoreError`, `isSecretStoreError`,
  `isWritableSecretProvider`, `SECRET_KEY_PATTERN`, `createMemorySecrets`, the writable-provider
  conformance checks and `SecretProviderFixtures.writableName`. A plugin that uses `ctx.secrets`
  declares `^2.2.0`.
- SDK 2.3.0 is additive: the canonical lists `PLUGIN_KINDS`, `SOURCE_MODES`, `HEALTH_STATUSES`,
  `TRACKING_MODES`, `INVOKE_STATUSES` and `RUN_STATES` (also on the browser-safe `/constants`
  subpath, which also carries `MAX_INVOKE_TIMEOUT_SECONDS`) with the unions `SourceMode`,
  `InvokeStatus` and `RunState` derived from them, and `isOneOf` and `errorText` on the root and
  `/json`.
- Your plugin's own version is yours, but treat event type ids, attribute names and action ids as
  public API: people's filters and processes depend on them. Removing or renaming one is a major.
- SDK majors are announced through the `switchboard-plugin` topic on the repository.
