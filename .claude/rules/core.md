---
paths:
  - 'packages/core/**'
---

# Core server conventions

- Layering, top to bottom:
  - `api/` holds Fastify routes. They parse and validate the request, check the role, call a
    service and shape the response DTO. No SQL in routes.
  - `services/` orchestrates. It reads and writes Postgres through `db/` and calls pure stages
    and the plugin runtime.
  - `pipeline/`, `expr/` and `scheduler/` hold pure logic (no DB, no I/O, `now` passed in).
  - `plugins/` holds the host (discovery, registration, instantiation) and implements `PluginRuntime`.
  - `db/` holds the Drizzle schema, the client and migrations.
- Pass dependencies explicitly through a `Deps` object (`{ db, clock, runtime, queue, logger,
telemetry, config }`). No module-level singletons except constant tables.
- Every multi-row pipeline decision runs in one transaction (`db.transaction`). Use
  `SELECT ... FOR UPDATE` or advisory locks where two replicas could race, and rely on unique
  indexes as the final guard.
- Queue jobs (pg-boss) carry ids, not payloads, and handlers are idempotent: a re-delivered job
  re-reads the row and does nothing if the state already moved on.
- Plugin calls go through the runtime wrappers that catch, attribute and time them. A plugin
  exception becomes a recorded outcome, never an unhandled rejection.
- Routes:
  - Validate bodies with JSON Schema (Fastify `schema.body`).
  - Every mutating route requires a non-empty `reason` and writes `audit_log` through
    `services/audit.ts`. Call `requireReason(req.body)` and give the body schema a `reason`
    property: when `requireReasons` is off, `api/reasons.ts` fills a blank one with
    "(no reason given)" for such routes (and for bodiless DELETEs).
  - Role checks use `requireRole('operator')` style preHandlers. A viewer gets 403, with a message
    that names the role.
  - Keep `src/contract/` and `docs/api.md` in sync with the routes.
- Logs are pino JSON with `event_id`, `process_id`, `batch_id`, `run_id`, `external_url` where
  they exist. Never log secret values or raw bodies.
- Metrics use the names in the TDD's Observability table (`switchboard.events`,
  `switchboard.runs`, ...) and are emitted via `telemetry/`.
