import { describe, expect, it } from 'vitest';

import type { ActionResult, ActionSpec } from '@ai-switchboard/sdk';

import { checkActionArgs, guardActions } from './actions.js';

const specs: ActionSpec[] = [
  {
    id: 'addLabel',
    title: 'Add label',
    argsSchema: {
      type: 'object',
      required: ['label'],
      properties: { label: { type: 'string' } },
      additionalProperties: false,
    },
  },
  { id: 'comment', title: 'Comment', argsSchema: { type: 'object' } },
];

describe('checkActionArgs', () => {
  const cases: {
    name: string;
    action: string;
    args: unknown;
    expected: 'ok' | RegExp;
  }[] = [
    { name: 'valid args', action: 'addLabel', args: { label: 'x' }, expected: 'ok' },
    { name: 'any object for a loose schema', action: 'comment', args: { a: 1 }, expected: 'ok' },
    {
      name: 'an unknown action names the declared ones',
      action: 'merge',
      args: {},
      expected: /unknown action "merge".*addLabel, comment/,
    },
    {
      name: 'a missing required field',
      action: 'addLabel',
      args: {},
      expected: /invalid args for action "addLabel".*label/,
    },
    {
      name: 'a wrong type',
      action: 'addLabel',
      args: { label: 3 },
      expected: /invalid args for action "addLabel"/,
    },
    {
      name: 'an extra field',
      action: 'addLabel',
      args: { label: 'x', extra: true },
      expected: /invalid args for action "addLabel"/,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const refusal = checkActionArgs(specs, c.action, c.args);
      if (c.expected === 'ok') expect(refusal).toBeUndefined();
      else {
        expect(refusal?.ok).toBe(false);
        expect(refusal?.message).toMatch(c.expected);
      }
    });
  }

  it('refuses every action when the type declares none', () => {
    expect(checkActionArgs(undefined, 'addLabel', {})?.message).toMatch(
      /unknown action "addLabel".*declares no actions/,
    );
  });
});

describe('guardActions', () => {
  function target() {
    const calls: { action: string; args: unknown }[] = [];
    return {
      calls,
      obj: {
        other: () => 'untouched',
        act: (action: string, args: unknown): Promise<ActionResult> => {
          calls.push({ action, args });
          return Promise.resolve({ ok: true });
        },
      },
    };
  }

  it('calls the plugin only with a declared action and valid args', async () => {
    const t = target();
    const guarded = guardActions(t.obj, specs);
    await expect(guarded.act('addLabel', { label: 'x' })).resolves.toEqual({ ok: true });
    await expect(guarded.act('addLabel', {})).resolves.toMatchObject({ ok: false });
    await expect(guarded.act('merge', {})).resolves.toMatchObject({ ok: false });
    expect(t.calls).toEqual([{ action: 'addLabel', args: { label: 'x' } }]);
    expect(guarded.other()).toBe('untouched');
  });

  it('leaves an object without act alone', () => {
    const obj = { health: () => 1 };
    expect(guardActions(obj, specs)).toBe(obj);
  });
});
