import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MeterBand } from './MeterBand.js';

const T0 = Date.parse('2026-09-27T20:44:15Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

describe('MeterBand', () => {
  it('draws runs after the last reading, and a lone reading as a visible band', () => {
    // The real API's first minutes: one reading, then two runs a few seconds later.
    render(
      <MeterBand
        meters={[
          {
            id: 'endpoint',
            title: 'Endpoint capacity',
            estimated: false,
            readings: [{ t: iso(0), utilization: 30, resetsAt: null }],
            ceilings: [],
          },
        ]}
        runs={[
          { t: iso(5_000), runId: 'r1', processId: 'p1', processName: 'Healthy', status: 'ok' },
          { t: iso(6_000), runId: 'r2', processId: 'p2', processName: 'Breaker', status: 'error' },
        ]}
      />,
    );
    const svg = screen.getByRole('img', { name: 'Meter history with 2 run markers' });
    expect(svg.querySelectorAll('[data-part="run"]')).toHaveLength(2);
    const band = svg.querySelector('[data-part="band"]');
    expect(band?.getAttribute('points')?.split(' ').length).toBeGreaterThanOrEqual(2);
  });
});
