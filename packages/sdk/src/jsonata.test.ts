import { describe, expect, it } from 'vitest';

import { asList, compileExpression, MappingError } from './jsonata.js';

const NOW = '2026-09-30T12:00:00.000Z';

describe('compileExpression', () => {
  it('evaluates to plain JSON data', async () => {
    const expr = compileExpression('items.{ "id": id }', 'mapping');
    await expect(expr.evaluate({ items: [{ id: 1 }, { id: 2 }] }, NOW)).resolves.toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  it('pins $now() and $millis() to the given instant', async () => {
    const expr = compileExpression('[$now(), $millis()]', 'mapping');
    await expect(expr.evaluate({}, NOW)).resolves.toEqual([NOW, Date.parse(NOW)]);
  });

  it('refuses $random()', async () => {
    const expr = compileExpression('$random()', 'mapping');
    await expect(expr.evaluate({}, NOW)).rejects.toThrow(/\$random\(\) is not available/);
  });

  it('names the expression when it does not compile', () => {
    expect(() => compileExpression('items[', 'cursor expression')).toThrow(MappingError);
    expect(() => compileExpression('items[', 'cursor expression')).toThrow(
      /^cursor expression does not compile: /,
    );
  });

  it('wraps a runtime error as MappingError', async () => {
    const expr = compileExpression('$number("x") + $undefinedFn()', 'mapping');
    const err: unknown = await expr.evaluate({}, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MappingError);
    expect((err as Error).message).toMatch(/^mapping failed: /);
  });

  it('stops an expression that recurses too deeply', async () => {
    const expr = compileExpression('($f := function($n) { $f($n + 1) }; $f(0))', 'mapping');
    await expect(expr.evaluate({}, NOW)).rejects.toThrow(MappingError);
  });

  it('gives undefined for no match', async () => {
    await expect(compileExpression('missing', 'mapping').evaluate({}, NOW)).resolves.toBe(
      undefined,
    );
  });
});

describe('asList', () => {
  it.each([
    [undefined, []],
    [null, []],
    [1, [1]],
    [
      [1, 2],
      [1, 2],
    ],
  ])('%j → %j', (value, expected) => {
    expect(asList(value)).toEqual(expected);
  });
});
