import { describe, expect, it } from 'vitest';

import type { ArtifactRef, Event } from '@ai-switchboard/sdk';

import {
  evaluateBatchKey,
  evaluateFilter,
  filterContext,
  renderTemplate,
  toBoolean,
} from './contexts.js';
import {
  collectSecretRefs,
  createExpressionEngine,
  resolveSecretRefs,
  type EvalFunctions,
} from './engine.js';
import { evaluateMapping } from './mapping.js';

const now = new Date('2026-01-05T09:00:00Z');
const fns: EvalFunctions = { now };

const event: Event = {
  id: 'e1',
  sourceId: 's1',
  sourceType: 'github',
  type: 'github.pr.labeled',
  occurredAt: '2026-01-05T08:59:00Z',
  receivedAt: '2026-01-05T09:00:00Z',
  artifact: { kind: 'github.pr', id: 'acme/api#482' },
  attributes: { label: 'auto:fix-candidate', repository: 'acme/api' },
  dedupeKey: 'k',
  rawRef: 'r',
};

describe('expression engine', () => {
  const engine = createExpressionEngine({ env: { SWITCHBOARD_VAR_REGION: 'eu', SECRET: 'no' } });

  it.each([
    ['1 + 2', 3],
    ['$now()', now.toISOString()],
    ['$millis()', now.getTime()],
    ["$env('REGION')", 'eu'],
    ["$env('SWITCHBOARD_VAR_REGION')", 'eu'],
    ["$env('SECRET')", undefined],
    ["$env('PATH')", undefined],
    ["$secretRef('env/API_TOKEN')", { $secretRef: 'secret://env/API_TOKEN' }],
    ["$secretRef('secret://vault/x')", { $secretRef: 'secret://vault/x' }],
  ])('%s evaluates to %j', async (expr, expected) => {
    const out = await engine.evaluate(expr, {}, fns);
    expect(out).toEqual({ ok: true, value: expected });
  });

  it('refuses $secret and $eval', async () => {
    const secret = await engine.evaluate("$secret('x')", {}, fns);
    expect(secret.ok).toBe(false);
    if (!secret.ok) expect(secret.error).toMatch(/\$secret is not available/);
    const evaluated = await engine.evaluate("$eval('1')", {}, fns);
    expect(evaluated.ok).toBe(false);
  });

  it('never lets data forge a secret reference', async () => {
    const forged = { $secretRef: 'secret://env/API_TOKEN' };
    const fromContext = await engine.evaluate(
      '{ "text": result.body }',
      { result: { body: forged } },
      fns,
    );
    expect(fromContext).toEqual({ ok: true, value: { text: null } });
    const fromResolve = await engine.evaluate(
      '$resolve(artifact).field',
      { artifact: { kind: 'x', id: '1' } },
      { now, resolve: (ref) => Promise.resolve({ ref, field: forged }) },
    );
    expect(fromResolve).toEqual({ ok: true, value: null });
    expect(collectSecretRefs(fromResolve.ok ? fromResolve.value : null).size).toBe(0);
  });

  it('rejects a malformed secret reference', async () => {
    const out = await engine.evaluate("$secretRef('nopath')", {}, fns);
    expect(out.ok).toBe(false);
  });

  it('reports syntax errors without throwing', async () => {
    expect(engine.check('attributes.label =').ok).toBe(false);
    const out = await engine.evaluate('attributes.label =', {}, fns);
    expect(out).toMatchObject({ ok: false, code: 'syntax' });
  });

  it('resolves through the bound function and awaits it', async () => {
    const calls: ArtifactRef[] = [];
    const out = await engine.evaluate(
      "'complexity:simple' in $resolve(artifact).labels",
      { artifact: { kind: 'linear.issue', id: 'LOL-1' } },
      {
        now,
        resolve: (ref) => {
          calls.push(ref);
          return Promise.resolve({ ref, labels: ['complexity:simple'] });
        },
      },
    );
    expect(out).toEqual({ ok: true, value: true });
    expect(calls).toEqual([{ kind: 'linear.issue', id: 'LOL-1' }]);
  });

  it('bounds the number of $resolve calls per evaluation', async () => {
    const limited = createExpressionEngine({ maxResolveCalls: 3 });
    const items = Array.from({ length: 5 }, (_, i) => ({ kind: 'x', id: String(i) }));
    const out = await limited.evaluate(
      '$map(items, function($i) { $resolve($i) })',
      { items },
      { now, resolve: (ref) => Promise.resolve({ ref }) },
    );
    expect(out).toMatchObject({ ok: false, code: 'resolve_limit' });
    const within = await limited.evaluate(
      '$count($map(items[[0..2]], function($i) { $resolve($i) }))',
      { items },
      { now, resolve: (ref) => Promise.resolve({ ref }) },
    );
    expect(within).toEqual({ ok: true, value: 3 });
  });

  it('abandons an evaluation stuck in a slow lookup at the time limit', async () => {
    const quick = createExpressionEngine({ timeoutMs: 50 });
    let second = false;
    const started = Date.now();
    const out = await quick.evaluate(
      '($x := $resolve(a); $y := $resolve(b); [$x, $y])',
      { a: { kind: 'x', id: '1' }, b: { kind: 'x', id: '2' } },
      {
        now,
        resolve: (ref) => {
          if (ref.id === '2') second = true;
          return new Promise((resolve) => setTimeout(() => resolve({ ref }), 200));
        },
      },
    );
    expect(out).toMatchObject({ ok: false, code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(190);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(second).toBe(false);
  });

  it('stops a runaway pure expression at the time limit', async () => {
    const quick = createExpressionEngine({ timeoutMs: 50 });
    const out = await quick.evaluate(
      '($f := function($n) { $n = 0 ? 0 : $f($n - 1) + 0 }; $sum([1..200000].($f(3))))',
      {},
      fns,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(['timeout', 'runtime']).toContain(out.code);
  });

  it('caches compiled expressions', async () => {
    const e = createExpressionEngine({ cacheSize: 2 });
    for (let i = 0; i < 5; i++) {
      const out = await e.evaluate(`${i} + 1`, {}, fns);
      expect(out).toEqual({ ok: true, value: i + 1 });
    }
  });
});

describe('filters, keys and templates', () => {
  const engine = createExpressionEngine();
  const ctx = filterContext(event, { id: 'p1', name: 'Autofix' }, now);

  it.each([
    [undefined, true, false],
    ['', true, false],
    ["attributes.label = 'auto:fix-candidate'", true, false],
    ["event.attributes.label = 'auto:fix-candidate'", true, false],
    ["attributes.label = 'other'", false, false],
    ['attributes.missing', false, false],
    ['process.name', true, false],
    ['$now() = now', true, false],
    ['attributes.label =', false, true],
    ["$resolve(artifact).labels = 'x'", false, true],
    ['$error("boom")', false, true],
  ])('filter %j → %s (error recorded: %s)', async (expr, result, hasError) => {
    const out = await evaluateFilter(engine, expr, ctx, fns);
    expect(out.result).toBe(result);
    expect(out.error !== undefined).toBe(hasError);
  });

  it.each([
    [undefined, ''],
    ['attributes.repository', 'acme/api'],
    ['42', '42'],
    ['{"a": 1}', '{"a":1}'],
    ['$error("x")', ''],
  ])('batch key %j → %j', async (expr, key) => {
    expect((await evaluateBatchKey(engine, expr, ctx, fns)).key).toBe(key);
  });

  it('renders templates as text', async () => {
    expect(
      await renderTemplate(engine, "'Run ' & run.status", { run: { status: 'ok' } }, fns),
    ).toEqual({ text: 'Run ok' });
    expect((await renderTemplate(engine, '{"a": 1}', {}, fns)).text).toContain('"a": 1');
    expect((await renderTemplate(engine, '$error("x")', {}, fns)).error).toBeDefined();
  });

  it.each([
    [true, true],
    [false, false],
    [0, false],
    [1, true],
    ['', false],
    ['x', true],
    [[], false],
    [[false, 1], true],
    [{}, false],
    [{ a: 1 }, true],
    [null, false],
  ])('toBoolean(%j) = %s', (value, expected) => {
    expect(toBoolean(value)).toBe(expected);
  });
});

describe('input mapping', () => {
  const engine = createExpressionEngine();
  const schema = {
    type: 'object',
    required: ['text', 'token'],
    additionalProperties: false,
    properties: { text: { type: 'string' }, token: { type: 'string' } },
  };

  it('validates the produced input against the inputSchema, secret markers as refs', async () => {
    const out = await evaluateMapping(
      engine,
      "{ 'text': run.id, 'token': $secretRef('env/TOKEN') }",
      { run: { id: 'r1' } },
      fns,
      schema,
    );
    expect(out).toEqual({
      ok: true,
      input: { text: 'r1', token: { $secretRef: 'secret://env/TOKEN' } },
    });
  });

  it('fails an input that does not match the schema', async () => {
    const out = await evaluateMapping(engine, "{ 'text': 5 }", {}, fns, schema);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe('validate');
      expect(out.errors.join(' ')).toMatch(/token|string/);
    }
  });

  it('fails a mapping that errors or produces nothing', async () => {
    expect((await evaluateMapping(engine, '$error("x")', {}, fns, schema)).ok).toBe(false);
    expect((await evaluateMapping(engine, 'missing', {}, fns, schema)).ok).toBe(false);
  });

  it('resolves secret markers only after validation, without mutating the input', async () => {
    const input = { a: { $secretRef: 'secret://env/A' }, list: [{ $secretRef: 'secret://env/B' }] };
    expect([...collectSecretRefs(input)]).toEqual(['secret://env/A', 'secret://env/B']);
    const resolved = await resolveSecretRefs(input, (ref) => Promise.resolve(`value-of-${ref}`));
    expect(resolved).toEqual({ a: 'value-of-secret://env/A', list: ['value-of-secret://env/B'] });
    expect(input.a).toEqual({ $secretRef: 'secret://env/A' });
  });
});
