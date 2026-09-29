import { validateAgainst, type ActionResult, type ActionSpec } from '@ai-switchboard/sdk';

/** A refusal for an undeclared action or args that fail its `argsSchema`; undefined when valid. */
export function checkActionArgs(
  specs: readonly ActionSpec[] | undefined,
  action: string,
  args: unknown,
): ActionResult | undefined {
  const spec = specs?.find((s) => s.id === action);
  if (!spec) {
    const declared =
      specs && specs.length > 0
        ? `declared: ${specs.map((s) => s.id).join(', ')}`
        : 'the type declares no actions';
    return { ok: false, message: `unknown action "${action}" (${declared})` };
  }
  const check = validateAgainst(spec.argsSchema, args);
  if (check.valid) return undefined;
  return {
    ok: false,
    message: `invalid args for action "${action}": ${check.errors.slice(0, 5).join('; ')}`,
  };
}

type Actor = (action: string, args: unknown) => Promise<ActionResult>;

/** The plugin's `act` only ever sees a declared action with args valid against its schema. */
export function guardActions<T extends object>(
  target: T,
  specs: readonly ActionSpec[] | undefined,
): T {
  if (typeof (target as { act?: unknown }).act !== 'function') return target;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (prop !== 'act' || typeof value !== 'function') return value;
      const act = value as Actor;
      return (action: string, args: unknown): Promise<ActionResult> => {
        const refusal = checkActionArgs(specs, action, args);
        return refusal ? Promise.resolve(refusal) : act.call(obj, action, args);
      };
    },
  });
}
