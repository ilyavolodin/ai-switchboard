import { describe, expect, it } from 'vitest';

import { destinationHref, processHref, sourceHref, traceHref } from './hrefs.js';

describe('hrefs', () => {
  it('encodes the id and appends a tab', () => {
    expect(processHref('p 1/x')).toBe('/processes/p%201%2Fx');
    expect(processHref('p1', 'edit')).toBe('/processes/p1/edit');
    expect(sourceHref('src-linear', 'settings')).toBe('/sources/src-linear/settings');
    expect(destinationHref('ex#1')).toBe('/destinations/ex%231');
    expect(traceHref('#482')).toBe('/activity/trace/%23482');
  });
});
