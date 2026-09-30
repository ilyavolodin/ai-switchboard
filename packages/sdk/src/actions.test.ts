import { describe, expect, it } from 'vitest';

import { dispatchAction } from './actions.js';
import type { ActionSpec } from './types/common.js';

const specs: ActionSpec[] = [
  {
    id: 'comment',
    title: 'Comment',
    argsSchema: {
      type: 'object',
      required: ['body'],
      properties: { body: { type: 'string', minLength: 1 } },
    },
  },
  { id: 'unhandled', title: 'Declared only', argsSchema: { type: 'object' } },
];

const handlers = {
  comment: (args: { body: string }) => Promise.resolve({ ok: true, message: `said ${args.body}` }),
};

describe('dispatchAction', () => {
  it('runs the handler with validated args', async () => {
    await expect(dispatchAction(specs, handlers, 'comment', { body: 'hi' })).resolves.toEqual({
      ok: true,
      message: 'said hi',
    });
  });

  it('refuses invalid args without running the handler', async () => {
    const result = await dispatchAction(specs, handlers, 'comment', { body: '' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^Invalid args: /);
  });

  it.each(['missing', 'unhandled', 'toString'])('refuses unknown action %s', async (action) => {
    await expect(dispatchAction(specs, handlers, action, {})).resolves.toEqual({
      ok: false,
      message: `Unknown action "${action}"`,
    });
  });
});
