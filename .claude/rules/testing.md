# Testing conventions

- Vitest everywhere. Import `describe/it/expect/vi` from `vitest` explicitly (globals are off).
- Unit tests sit next to the code (`batch.ts` → `batch.test.ts`) and run with no network, no
  Docker and no real time. Use `FakeClock` from `packages/core/src/clock.ts`, and
  `createStubHttp` / `createTestContext` / `rawRequest` / `runHandle` from
  `@ai-switchboard/sdk/testing`.
- Pipeline stages get table-driven tests that cover each TDD rule: dedupe collapses a
  redelivery; batching resets on join and closes on size, age and debounce; gate order and
  reasons; budget ceilings with fresh and stale meters; the idempotency rule; breaker
  open/cooldown; cron across DST and `catchUp`; expression limits.
- Integration tests (`packages/*/test/integration/**/*.test.ts`) run against a real Postgres
  started by `packages/core/test/integration/global-setup.ts` (Testcontainers, or
  `DATABASE_URL` when set). Each test file creates its own schema or truncates the tables it
  uses. Files run serially.
- Every reference plugin has `src/plugin.test.ts` that runs the SDK conformance kit
  (`sourceConformanceChecks` / `executorConformanceChecks` via `runConformance`) plus
  plugin-specific tests. Fixtures live in `src/__fixtures__/`. Fixture secrets are obviously fake
  (`fixture-secret`).
- UI component tests use Testing Library (`@testing-library/react`, `user-event`) in jsdom.
  Query by role and accessible name, not by CSS class.
- Assert on behaviour and outcomes (the run status, the stored row, the rendered label), not on
  implementation details or call counts, unless the call is the behaviour (for example "never a
  second invoke").
- A bug fix starts with a failing test.
