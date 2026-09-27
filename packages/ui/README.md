# @ai-switchboard/ui

The AI Switchboard web UI: React 19 + Vite 8 + TypeScript, TanStack Query, React Router 8
(data router), React Flow. It builds into `packages/core/public`, which the core serves.

The look is the **"AI Switchboard UI" Claude Design canvas** (Zest design system). The binding
conventions are in `.claude/rules/ui.md`. This file covers how the foundation is put together
and what a screen author needs to know.

```bash
pnpm dev:ui                               # Vite on :5173, proxies /api /hooks /callbacks /healthz → :8080
VITE_MOCK_API=1 pnpm dev:ui               # no backend: every endpoint answered from src/api/fixtures.ts
pnpm vitest run --project ui              # component tests (jsdom)
pnpm --filter @ai-switchboard/ui typecheck
pnpm --filter @ai-switchboard/ui build    # → packages/core/public
```

## Layout

```
index.html, public/favicon.svg     the logo mark ("Cg") as the favicon
vite.config.ts                     react plugin, source condition, dev proxy, outDir ../core/public
vitest.config.ts                   project `ui`, jsdom, src/test/setup.ts
src/main.tsx                       fonts, tokens, theme, optional mock API, <App/>
src/styles/tokens.css              every Zest token (light :root, dark [data-theme="dark"]) + mockup aliases
src/styles/global.css              base, focus ring, .t-* type classes, .mono, .visually-hidden
src/app/
  routes.tsx                       THE route table (every IA path; placeholders are <ComingSoon>)
  App.tsx, AppProviders.tsx        router + QueryClient + toasts + reason prompt
  AppShell.tsx                     session (useMe → /login), Rail, TopBar, evaluation banner, <Outlet/>
  Rail.tsx, TopBar.tsx, CapacityStrip.tsx, nav.ts
  session.ts                       SessionContext, useSession, useCan(role), roleRequiredMessage
  shortcuts.ts                     the only place for key bindings (/, g b, g p, g a)
  theme.ts                         useTheme / setTheme (localStorage, try/catch, light default)
  search.ts                        top-bar search → /activity/trace/:query
  queryClient.ts                   retry policy; any 401 re-checks /auth/me
src/api/
  client.ts                        apiFetch, ApiRequestError, isApiRequestError, errorMessage
  keys.ts                          query-key factories (qk.*) and POLL intervals
  mutation.ts                      useApiMutation (typed route + invalidation)
  hooks/*.ts                       one hook per endpoint in docs/api.md (re-exported by index.ts)
  fixtures.ts                      buildFixtures(now): DTOs mirroring the mockups
  mockApi.ts                       createMockApi(): a fetch backed by a handler map, records calls
src/components/                    the component library (index.ts re-exports all)
src/hooks/                         useNow, useDebounced, useReducedMotion, reason.ts, toast.ts
src/lib/                           pure helpers (format, gauge, meter, funnel, schema, cron, tone, …)
src/screens/Board/                 the Board (flagship screen)
src/screens/Login, NoAccess        sign-in and "ask an admin"
src/test/                          setup.ts, render.tsx (renderWithProviders, renderApp), constants.ts
```

## Adding a screen

1. Create `src/screens/<Area>/<Screen>.tsx` (+ `.module.css`, + `.test.tsx`).
2. In `src/app/routes.tsx` replace the route's `<ComingSoon screen="…"/>` element with it. Keep the
   path and the parent's `handle.title` (the top bar shows it). Paths already exist for:
   `/`, `/processes`, `/processes/new`, `/processes/:id`, `/processes/:id/edit`, `/processes/:id/:tab`,
   `/sources`, `/sources/:id`, `/sources/:id/:tab`, `/executors`, `/executors/:id`,
   `/executors/:id/:tab`, `/activity`, `/activity/trace/:query`, `/approvals`, `/plugins`,
   `/plugins/:tab`, `/settings`, `/settings/:tab`, `/login`, `/no-access`.
3. Tabs are URL segments — use `<RoutedTabs>` with `to` links (`end` on the overview tab).
4. Start the page with `<PageHeader title back meta description actions />`; the shell already
   renders the rail, top bar and padding (`main` is a 16 px-gap flex column).

## Data

- Only hooks from `src/api` talk to the server (`import { useProcess, … } from '../../api/index.js'`).
  They are typed with `@ai-switchboard/core/contract` — **type-only imports** (`import type`);
  never import runtime code from core into the browser bundle.
- Queries: `useX(id)` are disabled until the id is defined. Lists that page return infinite
  queries (`data.pages.flatMap((p) => p.items)`, `hasNextPage`, `fetchNextPage` → `<LoadMore>`).
- Live data polls: board and status every 10 s, approvals 10 s, lists 30 s, activity 15 s (`POLL`).
- Previews (`usePreviewFilter`, `usePreviewInput`, `usePreviewCron`) are POSTs modelled as
  queries keyed by the request; pass `null` to pause, debounce input with `useDebounced`.
- Mutations take the request body plus path params (`{ id, reason, … }`, `{ batchId, reason }`,
  `{ id, version, reason }`, `{ pluginName, reason }`) and invalidate their area plus the board
  and status strip.
- **Every state-changing action goes through `useReasonedMutation(mutation, prompt)`** — it opens
  the app-wide `ReasonDialog`, then sends `{ ...vars, reason }`, and toasts success or the error:

  ```tsx
  const reset = useReasonedMutation(useResetBreaker(), {
    title: 'Reset the Autofix breaker?',
    consequence: 'Event runs resume immediately.',
    confirmLabel: 'Reset breaker',
  });
  <Button requires="operator" onClick={() => void reset.run({ id })}>
    Reset breaker
  </Button>;
  ```

  Fleet-affecting actions pass `danger: true` and a `consequence` sentence naming the effect (or
  render `<ConfirmDialog>` yourself).

- A save gated by a plugin schema uses `validateAgainstSchema(schema, value)` (same Ajv the form uses).

### Hooks (one per endpoint)

Auth `useMe`, `useLogin`, `useLogout`, `useWhoami`, `OIDC_START_URL` · Board `useStatus`,
`useBoard`, `usePluginTypes` · Sources `useSources`, `useSource`, `useSourceStats`,
`useSourceEvents`, `useCreateSource`, `useUpdateSource`, `useDeleteSource`, `useEnableSource`,
`useProvisionSource`, `useSendTestEvent`, `useReloadSource` · Executors `useExecutors`,
`useExecutor`, `useExecutorMeters`, `useExecutorUsage`, `useCreateExecutor`, `useUpdateExecutor`,
`useDeleteExecutor`, `useEnableExecutor`, `useReloadExecutor`, `useReadMeters`,
`useClearSoftHold` · Processes `useProcesses`, `useProcess`, `useProcessFunnel`,
`useProcessStats`, `useProcessVersions`, `useProcessVersion`, `useProcessBatches`,
`useProcessActivity`, `usePreviewFilter`, `usePreviewInput`, `usePreviewCron`,
`useCreateProcess`, `useUpdateProcess` (409 on stale `expectedVersion`), `useDeleteProcess`,
`useEnableProcess`, `useRunProcess`, `useResetBreaker`, `useRestoreProcessVersion` · Activity
`useEvents`, `useEvent`, `useEventTrace`, `useTrace`, `useReplayEvent` · Runs `useRuns`, `useRun`,
`useCloseRun` · Approvals `useApprovals`, `useApprovalHistory`, `useApprovalRules`, `useApprove`,
`useReject` · Plugins `usePlugins`, `useCatalogue`, `useInspectPlugin`, `useInstallPlugin`,
`useRemovePlugin` · Notifiers / secret providers `useInstances(route)`, `useNotifiers`,
`useSecretProviders`, `useCreateInstance`, `useUpdateInstance`, `useEnableInstance`,
`useReloadInstance`, `useDeleteInstance`, `useTestNotifier` · Settings `useSettings`,
`useUpdateSettings`, `useUsers`, `useCreateUser`, `useUpdateUser`, `useDeleteUser`,
`useRevokeUserSessions`, `useTokens`, `useCreateToken`, `useDeleteToken`, `useAudit`,
`useExportYaml`, `useApply`, `useAbout`.

## Components (`src/components`)

| Component                                                                 | Purpose · key props                                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StatusChip`                                                              | Four tones, always a word · `tone label count? size`                                                                                                                      |
| `Button` / `LinkButton` / `IconButton`                                    | primary (gradient + glow), secondary, outline, soft, ghost, danger, danger-outline · `variant size loading icon requires` (role-gated: aria-disabled + tooltip)           |
| `Icon`, `Logo`, `Spinner`                                                 | Stroke icon set from the mockups (`name`) · the "Cg" mark (`gapColor`)                                                                                                    |
| `Card`, `PageHeader`                                                      | Surface card with title/meta/actions · screen header with back/meta/actions                                                                                               |
| `Tabs`, `RoutedTabs`, `SegmentedControl`, `FilterChips`                   | Local tabs · URL tabs · single-choice (incl. `variant="window"` 24 h/7 d/30 d) · toggle chips                                                                             |
| `Field`, `TextField`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Toggle` | Form controls; `Field` is a render prop giving `{ id, describedBy, invalid }`; `changed` = tangerine dot                                                                  |
| `SearchInput`, `Tooltip`, `Time`, `Countdown`                             | `/`-hinted search · hover/focus tip (aria-describedby) · relative time + absolute on hover · "resets in 2 h 10 m"                                                         |
| `MeterGauge`                                                              | Arc of used fraction, ceiling ticks, coral above ceiling, grey + "last read …" when stale, estimated · `meter size(sm                                                     | node | md  | lg) processId label` |
| `MeterBand`                                                               | Meter history bands with ceiling and run ticks · `meters runs processId`                                                                                                  |
| `PipelineDots`, `PipelineFunnel`, `StageIndicator`                        | Five dots (last hour) · funnel sized ∝ counts, sweeps as own stream · event stage stops                                                                                   |
| `Sparkline`, `BarChart`, `CapacityBar`                                    | Tiny line · grouped/stacked SVG bars with hidden data table · used/limit bar with ticks                                                                                   |
| `ArtifactChip`, `KeyValueList`, `CodeBlock`, `Mono`                       | Kind icon + id linking out (new tab) · collapsible attributes · pretty JSON (copy)                                                                                        |
| `ExpressionEditor`                                                        | JSONata textarea + insert chips + live evaluation rows (true/false/error) · `value onChange rows insertions`                                                              |
| `SchemaForm`                                                              | JSON Schema 2020-12 form (groups, x-order, x-secret refs, x-widget, defaults, Ajv messages) · `schema value onChange showAllErrors secretProviders secretStatus baseline` |
| `SecretRefInput`, `StringListInput`                                       | `secret://<provider>/<name>` input (never shows values) · editable string list                                                                                            |
| `CronField`, `QuietHoursBar`                                              | cron + cronstrue + next three from the API + timezone · 24-hour bar, editable                                                                                             |
| `Dialog`, `ReasonDialog`, `ConfirmDialog`, `Drawer`                       | Modal (focus trap, Escape) · reason required · consequence sentence required · side panel / bottom sheet                                                                  |
| `ReasonProvider`, `ToastProvider`                                         | App-level hosts behind `useReasonedMutation` and `useToast`                                                                                                               |
| `Banner`, `BreakerBanner`, `EmptyState`, `Skeleton`, `LoadMore`, `Table`  | error/warn/info/neutral strip · red breaker banner with failed runs + Reset slot · teaching empty state (ghost nodes) · loading · pagination · runs/audit tables          |
| `TraceTimeline`                                                           | Vertical timeline of `TraceEntry` with tone dots, expandable data, links, "Copy as text"                                                                                  |
| `NodeCard`, `SourceNode`, `ProcessNode`, `ExecutorNode`, `FlowNode`       | Canvas nodes (border = status); `FlowNode` is the React Flow node type with handles + hover card                                                                          |

## Theming and styling

- Colours, type, spacing, radii, shadows, gradients are CSS variables in `tokens.css`. **No hex in
  components.** The mockups' inline styles use aliases (`--card`, `--foreground-strong`,
  `--muted-foreground`, `--border-1`, `--st-ok-bg`, `--gradient-tangerine`, …) that exist too, so
  a mockup `style="…"` ports straight into a CSS module.
- Status tones: `--st-ok|warn|err|off` (+ `-bg`, `-fg`); `toneVars(tone)` in `lib/tone.ts`.
- Light is default. `setTheme('dark')` sets `data-theme="dark"` on `<html>` (the rail has a toggle).
- CSS modules, colocated (`Component.module.css`); global classes: `.t-page-title`,
  `.t-screen-title`, `.t-card-title`, `.t-section-title`, `.t-caption`, `.t-overline`, `.mono`,
  `.visually-hidden`.
- Breakpoints: ≤ 1100 px compact rail (icons) and single-column grids; ≤ 760 px bottom nav, 44 px
  touch targets (Board and Approvals must stay readable there).

## Gotchas

- **React Compiler lint rules are on** (`react-hooks/purity`, `set-state-in-effect`, `refs`,
  `immutability`, `static-components`): never call `Date.now()` in render — use `useNow()` or
  `now()` from `lib/clock.ts` (tests pin it to `TEST_NOW`); define components at module level.
- **`react-refresh/only-export-components`** (zero warnings): a `.tsx` file exports components
  only. Put helpers/constants in `src/lib/*.ts` or a sibling `.ts` file.
- Strict type-checked ESLint: no `!` non-null assertions and no `x as T` where `T` only drops
  `undefined` — use `at(list, i)` from `lib/at.ts` in fixtures, narrow elsewhere.
- Relative imports end in `.js` (even for `.tsx`).
- Utilization is a **percentage 0–100** (SDK); ceilings too. `meterFraction()` converts.
- Disabled controls use `aria-disabled` (still focusable, explain themselves in a tooltip). Tests
  assert `toHaveAttribute('aria-disabled', 'true')`, not `toBeDisabled()`.
- External links: `target="_blank" rel="noreferrer"`. Times: `<Time value>`.
- Name UI tests `*.test.tsx` (the root `unit` project would also pick up `*.test.ts` under node).

## Tests

`renderWithProviders(ui, { role, path, routePath, overrides })` renders a component with the query
client, toasts, reason prompt, a session of `role` (`null` = signed out) and a memory router, with
`createMockApi()` stubbed as `fetch`; it returns `api` (`api.callsTo('POST /…')` to assert the sent
body), `user` (user-event) and `router`. `renderApp(path)` renders the whole route table. Query by
role and accessible name. React Flow works in jsdom thanks to the stubs in `test/setup.ts`.

## End-to-end tests (Playwright, real stack)

`e2e/` runs the built UI against the real core, Postgres and the stub server — no mock API. It
answers the four questions the UI exists for (see a breaker on the Board and reset it, find an
artifact's trace by id with `/`, read a meter on the executor and in the top bar, edit a process
and find the change in the audit log), signs in and out, smoke-tests every route (no error state,
no uncaught or console error, no failed `/api` call, no `undefined`/`NaN`/`[object Object]` in the
page), and compares the Board at 1440 and 1024 px in light mode against
`e2e/__screenshots__/` (times and countdowns masked).

```bash
pnpm --filter @ai-switchboard/ui exec playwright install chromium   # once
pnpm --filter @ai-switchboard/ui test:e2e       # pnpm build, then playwright test (needs Docker)
pnpm --filter @ai-switchboard/ui test:e2e:only  # skip the build (after your own pnpm build)
pnpm --filter @ai-switchboard/ui test:e2e:only --update-snapshots   # refresh the Board baselines
```

- `e2e/global-setup.ts` starts `postgres:17-alpine` with `docker run` on a free port,
  `deploy/stub/server.js`, and `packages/core/dist/main.js` (evaluation mode, local admin
  password, `SWITCHBOARD_HOME` in a temp dir, `WEBHOOK_SECRET` / `STUB_CALLBACK_SECRET` for the
  `env` secret provider), and removes them all on teardown. Their logs are in
  `test-results/e2e-stack/`.
- `e2e/seed.ts` applies one YAML through `POST /api/v1/apply`: a webhook source, an `http`
  executor on the stub with the stub's `GET /meter` as its meter, and three processes routed by
  the alert's `route` attribute — _Breaker demo_ (the stub's error callback, breaker threshold 1),
  _Healthy alerts_ (sync `ok`) and _Approval demo_ (`approval: always`). It sends one signed alert
  each through the stub's `/send` and polls the API until the run is ok, the breaker is open and
  the approval is pending. The ids reach the tests as `process.env.E2E_STATE`.
- The `visual` project runs first (its baselines are of the seeded state); `flows` depends on it.
  Tests share one database, so there is one worker. The breaker test re-opens the breaker it
  resets, so the suite can run again against the same stack: set `E2E_STATE` to a seeded stack's
  state JSON and global setup reuses it instead of starting one.
- Baselines are per platform (`board-1440-darwin.png`); a Linux CI needs its own
  (`--update-snapshots` once in the CI image).
- `E2E_SHOTS=<dir>` makes the smoke tests save a full-page screenshot of every route.
- Fixtures (`e2e/fixtures.ts`): `page` is signed in (`test.use({ signedIn: false })` to opt out);
  `api` is an admin API client; `allowedApiErrors` lists expected 4xx/5xx as regexes.
