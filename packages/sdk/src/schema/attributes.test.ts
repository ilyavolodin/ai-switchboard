import { describe, expect, it } from 'vitest';

import { attr, flatAttributesSchema } from './attributes.js';

describe('flatAttributesSchema', () => {
  it('builds a closed object requiring every property by default', () => {
    expect(
      flatAttributesSchema({ repo: attr.string('Repo.'), labels: attr.strings('Labels.') }),
    ).toEqual({
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels.' },
      },
      required: ['repo', 'labels'],
      additionalProperties: false,
    });
  });

  it('takes an explicit required list', () => {
    const schema = flatAttributesSchema(
      { n: attr.integer('N.'), ok: attr.boolean('Ok.'), x: attr.number('X.') },
      ['n'],
    );
    expect(schema.required).toEqual(['n']);
  });
});
