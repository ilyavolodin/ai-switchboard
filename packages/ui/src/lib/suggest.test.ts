import { describe, expect, it } from 'vitest';

import {
  expressionCompletions,
  parseSampleBody,
  rankSuggestions,
  samplePaths,
  wordAt,
} from './suggest.js';

describe('samplePaths', () => {
  it('lists every dotted path of body, headers and query with an example value', () => {
    const paths = samplePaths({
      body: { issue: { id: 'ISS-1', labels: [{ name: 'bug' }, { name: 'p1' }] }, n: 3 },
      headers: { 'X-Event-Type': 'issue.created' },
      query: { env: 'staging' },
    });
    expect(paths.map((p) => [p.value, p.hint])).toEqual([
      ['body', 'object'],
      ['body.issue', 'object'],
      ['body.issue.id', '"ISS-1"'],
      ['body.issue.labels', 'list of 2'],
      ['body.issue.labels.0', 'object'],
      ['body.issue.labels.0.name', '"bug"'],
      ['body.issue.labels.1', 'object'],
      ['body.issue.labels.1.name', '"p1"'],
      ['body.issue.labels.name', 'list of 2'],
      ['body.n', '3'],
      ['headers.x-event-type', '"issue.created"'],
      ['query.env', '"staging"'],
    ]);
  });

  it('parses JSON bodies and returns null for anything else', () => {
    expect(parseSampleBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseSampleBody('not json')).toBeNull();
    expect(parseSampleBody('  ')).toBeNull();
  });
});

describe('rankSuggestions and wordAt', () => {
  const items = [{ value: 'body.issue.id' }, { value: 'body.id' }, { value: 'headers.x-id' }];

  it('puts prefix matches first, then substring matches, and skips an exact match', () => {
    expect(rankSuggestions(items, 'body.i').map((s) => s.value)).toEqual([
      'body.issue.id',
      'body.id',
    ]);
    expect(rankSuggestions(items, 'id').map((s) => s.value)).toEqual([
      'body.issue.id',
      'body.id',
      'headers.x-id',
    ]);
    expect(rankSuggestions(items, 'body.id')).toEqual([]);
    expect(rankSuggestions(items, '', 2)).toHaveLength(2);
  });

  it('finds the word under the cursor, but not inside a string literal', () => {
    expect(wordAt('attributes.lab', 14)).toEqual({ start: 0, word: 'attributes.lab' });
    expect(wordAt('x = $res', 8)).toEqual({ start: 4, word: '$res' });
    expect(wordAt("label = 'attr", 13)).toEqual({ start: 13, word: '' });
    expect(wordAt('a and ', 6)).toEqual({ start: 6, word: '' });
  });
});

describe('expressionCompletions', () => {
  it('offers declared attributes, the context’s fields and the functions', () => {
    const values = expressionCompletions({
      context: 'filter',
      attributes: [{ name: 'label', type: 'string' }],
    }).map((s) => s.value);
    expect(values.slice(0, 2)).toEqual(['attributes.label', 'event.attributes.label']);
    expect(values).toEqual(
      expect.arrayContaining(['event', 'event.artifact.kind', 'process.name', 'now']),
    );
    expect(values).toContain('$resolve(artifact)');
    expect(values).toContain('$count()');
    expect(values).not.toContain('run');
    expect(values).not.toContain('events.attributes.label');
  });

  it('follows the core’s run context in an input mapping', () => {
    const values = expressionCompletions({ context: 'mapping' }).map((s) => s.value);
    expect(values).toEqual(expect.arrayContaining(['run.dryRun', 'run.processId', 'mode']));
    expect(values).not.toContain('run.status');
  });

  it('leaves out names that do not apply', () => {
    const before = expressionCompletions({ context: 'step', without: ['result'] });
    expect(before.map((s) => s.value)).not.toContain('result');
    expect(expressionCompletions({ context: 'step' }).map((s) => s.value)).toContain('result');
  });

  it('offers only JSONata’s functions to plugin expressions', () => {
    const values = expressionCompletions({ context: null, switchboardFunctions: false }).map(
      (s) => s.value,
    );
    expect(values).not.toContain('$resolve(artifact)');
    expect(values).not.toContain("$secretRef('provider/name')");
    expect(values).not.toContain('$secret(name)');
    expect(values).toContain('$join()');
  });
});
