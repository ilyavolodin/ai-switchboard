# TypeScript conventions (all packages)

- ESM only. Relative imports end in `.js`. Use `import type` for type-only imports (ESLint
  enforces `consistent-type-imports` with inline style).
- `strict` plus `noUncheckedIndexedAccess`: handle `undefined` from index access. Don't silence
  it with `!` in non-test code; narrow or default instead.
- Don't use `any`. At a boundary (JSON bodies, plugin return values, jsonb columns), type the value
  as `unknown` and validate it with Ajv (`validateAgainst` / `compileSchema` from the SDK) before
  you narrow.
- Prefer `interface` for object shapes that are part of a contract, and `type` for unions and
  mapped types.
- String-literal unions, not `enum`. Canonical lists live in one `as const` array
  (`packages/core/src/domain/status.ts`) and the union is derived from it.
- Errors: throw `Error` subclasses with a stable `name`. When an error can cross package
  boundaries, add a duck-typed guard (`isTransportError`). Don't use `instanceof` across packages.
- Import order: node built-ins, then external packages, then workspace packages
  (`@ai-switchboard/*`), then relative. Blank line between groups.
- Don't `console.log` in library code (ESLint `no-console`). Use the injected logger. The CLI is
  the exception.
- Keep functions small and pure where possible. Pass dependencies in explicitly (clock, db,
  runtime, logger) rather than importing singletons.
- Keep comments to a minimum. Write one only when the code can't say it: a non-obvious reason,
  invariant or workaround. Don't restate names or narrate steps, and don't add section banners.
  Public SDK types get a short doc comment only where the semantics aren't obvious from the name.
- Formatting belongs to Prettier (single quotes, trailing commas, width 100). Don't hand-format
  against it.
