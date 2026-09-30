import { validateAgainst } from './schema/index.js';
import type { ActionResult, ActionSpec } from './types/common.js';

/** `A` is the args shape the specs' `argsSchema`s describe; handlers see args already validated. */
export type ActionHandlers<A> = Readonly<Record<string, (args: A) => Promise<ActionResult>>>;

/**
 * Runs `action` for `act`: an unknown action (no spec, or no handler) and args that fail the
 * spec's `argsSchema` are refused with `{ ok: false }` before a handler runs.
 */
export function dispatchAction<A>(
  specs: readonly ActionSpec[],
  handlers: ActionHandlers<A>,
  action: string,
  args: unknown,
): Promise<ActionResult> {
  const spec = specs.find((s) => s.id === action);
  const handler = Object.hasOwn(handlers, action) ? handlers[action] : undefined;
  if (!spec || !handler)
    return Promise.resolve({ ok: false, message: `Unknown action "${action}"` });
  const check = validateAgainst(spec.argsSchema, args);
  if (!check.valid) {
    return Promise.resolve({ ok: false, message: `Invalid args: ${check.errors.join('; ')}` });
  }
  return handler(args as A);
}
