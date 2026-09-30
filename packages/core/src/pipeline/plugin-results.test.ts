import { describe, expect, it } from 'vitest';

import { checkInvokeResult, checkPollResult, checkRunStatus } from './plugin-results.js';

describe('checkRunStatus', () => {
  it.each([
    ['a running state', { state: 'running' }, true],
    ['a terminal state with its details', { state: 'ok', errors: [], outputs: 2 }, true],
    ['an unknown state', { state: 'done' }, false],
    ['no state', { errors: ['x'] }, false],
    ['errors that are not strings', { state: 'error', errors: [1] }, false],
    ['a numeric url', { state: 'ok', externalUrl: 5 }, false],
    ['not an object', 'ok', false],
    ['null', null, false],
  ])('%s', (_name, value, ok) => {
    expect(checkRunStatus(value).ok).toBe(ok);
  });

  it('names what is wrong', () => {
    const out = checkRunStatus({ state: 'done' });
    expect(out.ok ? '' : out.problem).toMatch(/^RunStatus is malformed: \/state/);
  });
});

describe('checkInvokeResult', () => {
  it.each([
    ['a started result', { status: 'started', externalId: 'r-1' }, true],
    // An unknown status is `classifyInvoke`'s to judge (a lost response), not a malformed result.
    ['an unknown status', { status: 'queued' }, true],
    ['no status', { externalId: 'r-1' }, false],
    ['a numeric status', { status: 1 }, false],
    ['errors that are not a list', { status: 'failed', errors: 'boom' }, false],
    ['undefined', undefined, false],
  ])('%s', (_name, value, ok) => {
    expect(checkInvokeResult(value).ok).toBe(ok);
  });
});

describe('checkPollResult', () => {
  it('reads a page', () => {
    expect(checkPollResult({ events: [{ a: 1 }], watermark: 'w2', notes: ['n'] }, 'w1')).toEqual({
      ok: true,
      value: { drafts: [{ a: 1 }], watermark: 'w2', notes: ['n'] },
    });
  });

  it('keeps the previous watermark and treats missing events as an empty page', () => {
    expect(checkPollResult({ watermark: 3 }, 'w1')).toEqual({
      ok: true,
      value: { drafts: [], watermark: 'w1', notes: [] },
    });
  });

  it.each([null, 'page', [1, 2]])('refuses %j', (value) => {
    expect(checkPollResult(value, null)).toEqual({
      ok: false,
      problem: 'poll returned no result object',
    });
  });
});
