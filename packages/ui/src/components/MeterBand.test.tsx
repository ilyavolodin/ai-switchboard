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
          {
            t: iso(5_000),
            runId: 'r1',
            processId: 'p1',
            processName: 'Healthy',
            status: 'ok',
            statusLabel: { tone: 'ok', label: 'ok' },
          },
          {
            t: iso(6_000),
            runId: 'r2',
            processId: 'p2',
            processName: 'Breaker',
            status: 'error',
            statusLabel: { tone: 'error', label: 'error' },
          },
        ]}
      />,
    );
    const svg = screen.getByRole('img', { name: 'Meter history with 2 run markers' });
    expect(svg.querySelectorAll('[data-part="run"]')).toHaveLength(2);
    const band = svg.querySelector('[data-part="band"]');
    expect(band?.getAttribute('points')?.split(' ').length).toBeGreaterThanOrEqual(2);
  });

  it('ignores a reading with an unreadable time when sizing the window', () => {
    render(
      <MeterBand
        meters={[
          {
            id: 'window',
            title: '5-hour window',
            estimated: false,
            readings: [
              { t: iso(0), utilization: 20, resetsAt: null },
              { t: 'not a time', utilization: 25, resetsAt: null },
              { t: iso(60_000), utilization: 40, resetsAt: null },
            ],
            ceilings: [],
          },
        ]}
      />,
    );
    const band = screen.getByRole('img').querySelector('[data-part="band"]');
    const xs = (band?.getAttribute('points') ?? '').split(' ').map((p) => Number(p.split(',')[0]));
    // Epoch 0 must not become the window start (every real point would sit at the right edge).
    expect(xs[0]).toBe(0);
    expect(xs.some(Number.isNaN)).toBe(false);
  });
});
