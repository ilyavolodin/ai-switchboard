---
paths:
  - 'packages/sdk/**'
---

# SDK conventions (the plugin contract)

- `@ai-switchboard/sdk` follows semver strictly and is the only contract plugins depend on:
  - Adding an optional field or a new export is a **minor**.
  - Changing or removing any interface method, or making a field required, is a **major**.
  - Call out the level in the commit message (`feat(sdk)!:` for a major).
- The SDK has no dependency on core. Keep runtime dependencies minimal (Ajv, ajv-formats).
- Everything a plugin author touches is exported from `src/index.ts` or `src/testing/index.ts`
  and doc-commented.
- The conformance kit (`src/testing/conformance.ts`) encodes the TDD's plugin rules. When the
  TDD adds a rule, add a check here and a test that the check fails on a bad plugin.
