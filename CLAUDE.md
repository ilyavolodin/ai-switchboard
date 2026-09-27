# AI Switchboard

An open-source service that turns events from the systems a team already runs (GitHub, Linear,
Datadog, any webhook) into controlled invocations of the automations they already have (Claude
Routines, HTTP endpoints, GitHub Actions), under budgets, schedules and approval gates a person
edits in a UI.

The authoritative spec is the Technical Design (TDD). `docs/` holds the parts that became
reference material: `docs/architecture.md`, `docs/api.md`, `docs/plugin-author-guide.md`,
`docs/runbook.md`.

## Fixed core, everything else a plugin

Three things are fixed and everything else is a plugin:

1. **Event envelope**: the one shape every source produces (`Event` in `packages/sdk/src/types/events.ts`).
2. **Dispatch pipeline**: receive → match → dedupe → batch → gate → budget → invoke/track. It is the one
   path every event, schedule tick and manual start walks (`packages/core/src/pipeline/`).
3. **Process**: one JSON document a person edits (`packages/core/src/domain/process.ts`).

Sources, executors, notifiers and secret providers are npm packages built with `definePlugin()`
from `@ai-switchboard/sdk`.

## Vocabulary: use exactly these words

_plugin, source, event, process, trigger, executor, run, usage, meter, action, batch, sweep
(a scheduled run), held (a gate stopped it), throttled (a budget or meter ceiling stopped it),
breaker, approval, budget, ceiling._ Don't use synonyms in code, UI copy, logs or docs: no
"job" for run, no "adapter" for source, no "workflow" for process.

## Repository layout

```
packages/sdk      @ai-switchboard/sdk     plugin interfaces, definePlugin, HttpClient, verifyHmac, conformance kit (/testing)
packages/core     @ai-switchboard/core    Fastify server: plugin host, pipeline, scheduler, REST API, auth, telemetry
packages/ui       @ai-switchboard/ui      React + Vite SPA, built into packages/core/public
packages/cli      @ai-switchboard/cli     `switchboard` command: plugins add/remove/list, export/apply, doctor
plugins/*         reference plugins       source-*, executor-*, notifier-*, secrets-*
deploy/           Dockerfile, docker-compose.yml, helm/
docs/             architecture, API, plugin author guide, runbook
examples/         YAML configurations
```

## Toolchain

- Node **24 LTS** (`.nvmrc`), **pnpm 10** via corepack (`packageManager` pins it), TypeScript 6.0
  (typescript-eslint doesn't support TS 7 yet), ESM only.
- Fastify 5, Drizzle ORM + drizzle-kit, pg-boss (jobs and crons on Postgres), JSONata, Ajv
  (draft 2020-12), OpenTelemetry, openid-client, pino.
- UI: React 19, React Router, TanStack Query, React Flow (`@xyflow/react`), plain CSS with the
  Zest design tokens (`packages/ui/src/styles/tokens.css`).
- Tests: Vitest (unit, integration, ui projects in `vitest.config.ts`), Testcontainers Postgres
  for integration, Playwright for e2e.

## Commands

```bash
pnpm install
pnpm typecheck            # tsc in every package (no build needed; see "source condition")
pnpm lint                 # eslint, zero warnings
pnpm format               # prettier --write
pnpm test                 # unit tests (no Docker)
pnpm test:integration     # needs Docker (Testcontainers) or DATABASE_URL
pnpm vitest run --project ui
pnpm test:e2e             # Playwright vs the real stack: builds, then Docker Postgres + stub + core (packages/ui/README.md)
pnpm build                # all packages, UI last
pnpm dev                  # core with tsx watch (needs DATABASE_URL); pnpm dev:ui for Vite
pnpm db:generate          # after editing packages/core/src/db/schema.ts
pnpm check                # typecheck + lint + format:check + unit tests: run before committing
```

Run a single test file: `pnpm vitest run packages/core/src/pipeline/batch.test.ts`.

## How packages resolve each other

Every workspace package exports a custom condition `@ai-switchboard/source` that points at
`src/*.ts`. `tsconfig.base.json`, Vitest and `tsx --conditions=...` use it, so typecheck, tests
and dev run from source with no build step. `tsconfig.build.json` clears `customConditions`, so
a build resolves siblings' `dist/` (build order: sdk → plugins → core → cli → ui).

Relative imports use the `.js` extension (NodeNext): `import { x } from './batch.js'`.

## Core design rules (don't break these)

- **Postgres is the only state.** There's no in-memory state in the pipeline. Replicas coordinate
  through pg-boss job locks and unique constraints. Anything that must survive a restart is a row.
- **Pure stages.** Each pipeline stage in `packages/core/src/pipeline/` is a pure function over
  plain data plus `now`. Persistence and I/O live in `packages/core/src/services/`. Test the
  stages with a `FakeClock` (`packages/core/src/clock.ts`) and no database.
- **Take the clock from `Clock`,** never `new Date()` / `Date.now()` in pipeline or service code.
  Plugins use `ctx.now()`.
- **Never retry a non-idempotent invoke that may have been sent.** Only `TransportError.sent === false`
  or a 503 is retried. Anything else leaves the run `uncertain` for tracking to settle.
- **The run row with `status=invoking` is the budget reservation.** It's written in the same
  transaction as the budget check. `runs.batch_id` is unique.
- **Held and throttled aren't failures,** and the batch isn't re-queued. The next sweep does the work.
- **Expressions can't fail the pipeline.** A filter error evaluates to `false` and is recorded. A
  mapping error fails the run before budget is spent. Every evaluation has a 2 s limit and a
  bounded `$resolve` count.
- **Secrets never touch Postgres or expressions.** Settings store `secret://<provider>/<name>`.
  Values live only in the live plugin object. `$secretRef(name)` yields a reference the executor
  bridge resolves after evaluation. The API never returns a secret value.
- **Every state-changing action carries a one-line `reason` and writes `audit_log`.** Routes reject
  an empty reason with 400.
- **Plugins are attributed.** Wrap every plugin call so exceptions and invalid events are counted
  against the plugin (`PluginRuntime.recordPluginError`) and never crash the pipeline.
- **One metric and one structured log line per pipeline decision,** with the same attributes
  (`packages/core/src/telemetry/`).

## Conventions

- Code conventions are in `.claude/rules/`. Path-scoped rules load when you work in their area.
- Tests sit next to the code: `foo.ts` → `foo.test.ts`. Integration tests go in
  `packages/*/test/integration/`.
- Every reference plugin runs the SDK conformance kit in its own `src/plugin.test.ts`.
- The API contract (`packages/core/src/api/contract.ts`) and `docs/api.md` change together with
  the routes.
- Changing `packages/sdk` public types is a semver decision: additive = minor, any change to an
  interface method = major. Say so in the commit message.
- Commit messages: Conventional Commits (`feat(core): ...`, `fix(ui): ...`, `test(plugins): ...`).
