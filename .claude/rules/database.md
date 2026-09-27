---
paths:
  - 'packages/core/src/db/**'
  - 'packages/core/drizzle/**'
---

# Database conventions

- The schema lives in `packages/core/src/db/schema.ts` (Drizzle, `casing: 'snake_case'`). After
  changing it, run `pnpm db:generate` and commit the generated SQL under
  `packages/core/drizzle/`. Never hand-edit a migration that has shipped. Add a new one instead.
- Timestamps are `timestamptz` (`mode: 'date'`). Ids are `uuid` with `defaultRandom()`, except
  high-volume append-only tables, which use identity bigints.
- Tables that hold plugin data use `jsonb` typed with `$type<...>()`.
- Secret values are never stored. Settings hold `secret://` references only.
- Rolling budget counters are computed from `runs` with covering indexes, not stored, so a
  corrected run corrects the budget.
- Retention is enforced by the nightly prune job, per table, as configured in Settings. Add new
  high-volume tables to the prune job.
- The pg-boss schema (`pgboss`) is owned by pg-boss. Don't reference it from Drizzle.
