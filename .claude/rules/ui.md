---
paths:
  - 'packages/ui/**'
---

# UI conventions

- The design source is the "AI Switchboard UI" canvas (Zest design system). Colors, type, radii,
  spacing and shadows come from CSS custom properties in `src/styles/tokens.css`. Never hard-code
  a hex value in a component. Light is the default; dark is `[data-theme="dark"]` on `<html>`.
- Fonts: Poppins (UI) and JetBrains Mono, self-hosted via `@fontsource`. Use monospace only for
  ids, expressions, counts in chips and log text.
- **Status vocabulary:** four tones, used identically everywhere and always paired with a text label.
  - `ok` (mint): ok, healthy, flowing.
  - `warn` (sun/tangerine): held, throttled, awaiting approval, stale.
  - `error` (coral): error, breaker open, unhealthy.
  - `off` (grey): disabled, not yet run.

  Use `<StatusChip tone label>`. Never show color without a word.

- A picture before a number. Flows are drawn (React Flow board, pipeline dots, funnel), budgets
  and meters are gauges and bands, activity is a timeline. Numbers are labels on pictures.
- Data fetching goes through TanStack Query hooks in `src/api/` (one hook per endpoint, typed with
  `@ai-switchboard/core/contract`). Components never call `fetch` directly.
- Every state-changing action opens a reason prompt (`<ReasonDialog>`) and sends `reason`. Actions
  that affect the whole fleet use `<ConfirmDialog>` with a sentence naming the effect.
- Viewer role: controls stay visible but are disabled, with a tooltip that names the required role
  (`useCan('operator')`).
- Relative times show the absolute time on hover (`<Time>`). External links open in a new tab
  with `rel="noreferrer"`.
- Keyboard: `/` focuses search, `g b` Board, `g p` Processes, `g a` Activity. Keep
  `src/app/shortcuts.ts` the single place for bindings.
- Accessibility: real `<button>`, `<a href>`, `<label>`. Icon-only buttons get `aria-label`.
  Contrast is at least 4.5:1. Touch targets are at least 44 px on the phone layouts
  (Board, Approvals).
- Components are function components with named exports, one per file in `src/components/`.
  Screens live in `src/screens/<Area>/`. Styles are colocated CSS modules
  (`Component.module.css`).
- Use the exact terminology from CLAUDE.md in all copy.
