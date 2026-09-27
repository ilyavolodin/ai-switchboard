import type { MeterGaugeDTO } from '@ai-switchboard/core/contract';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildFixtures } from '../api/fixtures.js';
import { arcDasharray, ceilingMark, GAUGE_CIRCUMFERENCE, meterFraction } from '../lib/gauge.js';
import { TEST_NOW } from '../test/constants.js';
import { MeterGauge } from './MeterGauge.js';

const f = buildFixtures(TEST_NOW);
const [fiveHour, weekly, dailyRuns] = f.executors[0]!.meters as [
  MeterGaugeDTO,
  MeterGaugeDTO,
  MeterGaugeDTO,
];

describe('gauge arithmetic', () => {
  it('draws 62% as 85.7 of a 138.2 circumference', () => {
    expect(GAUGE_CIRCUMFERENCE).toBeCloseTo(138.23, 2);
    expect(arcDasharray(0.62)).toBe('85.7 138.2');
    expect(arcDasharray(0)).toBe('0.0 138.2');
    expect(arcDasharray(1.4)).toBe('138.2 138.2');
  });

  it('places the 85% ceiling tick where the canvas draws it', () => {
    expect(ceilingMark(85)).toEqual({ x1: 14.2, y1: 18, x2: 6.2, y2: 12.1 });
    // 0% is straight up (12 o'clock), 25% at 3 o'clock.
    expect(ceilingMark(0)).toEqual({ x1: 28, y1: 11, x2: 28, y2: 1 });
    expect(ceilingMark(25)).toEqual({ x1: 45, y1: 28, x2: 55, y2: 28 });
  });

  it('reads utilization as a percentage and allowances as used/limit', () => {
    expect(meterFraction({ utilization: 62, used: null, limit: null })).toBeCloseTo(0.62);
    expect(meterFraction({ utilization: null, used: 14, limit: 22 })).toBeCloseTo(0.636, 3);
    expect(meterFraction({ utilization: null, used: null, limit: null })).toBeNull();
  });
});

describe('MeterGauge', () => {
  it('renders the arc, the ceiling tick and the reset countdown', () => {
    const { container } = render(<MeterGauge meter={fiveHour} size="lg" />);
    const img = screen.getByRole('img', { name: /5-hour window 62% used/ });
    expect(img).toHaveAccessibleName(expect.stringContaining('ceiling 85%'));
    const arc = container.querySelector('[data-part="arc"]');
    expect(arc).toHaveAttribute('stroke-dasharray', '85.7 138.2');
    expect(arc).toHaveAttribute('stroke', 'var(--primary)');
    const tick = container.querySelector('[data-part="ceiling"]');
    expect(tick).toHaveAttribute('data-percent', '85');
    expect(tick).toHaveAttribute('x1', '14.2');
    expect(screen.getByText('resets in 2 h 10 m')).toBeInTheDocument();
  });

  it('greys a stale meter and says when it was last read', () => {
    const { container } = render(<MeterGauge meter={weekly} size="lg" />);
    expect(container.querySelector('[data-part="arc"]')).toHaveAttribute(
      'stroke',
      'var(--line-strong)',
    );
    expect(screen.getByText('last read 42 min ago')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(expect.stringContaining('stale'));
  });

  it('turns coral above the lowest event ceiling', () => {
    const hot = { ...fiveHour, utilization: 91 };
    const { container } = render(<MeterGauge meter={hot} />);
    expect(container.querySelector('[data-part="arc"]')).toHaveAttribute('stroke', 'var(--st-err)');
    expect(screen.getByRole('img')).toHaveAccessibleName(
      expect.stringContaining('above ceiling, throttled'),
    );
  });

  it('shows allowances as used/limit and labels estimates', () => {
    render(<MeterGauge meter={dailyRuns} size="lg" />);
    expect(screen.getByText('14/22')).toBeInTheDocument();
    expect(screen.getByText(/estimated/)).toBeInTheDocument();
  });

  it('draws only the given process ceilings', () => {
    const { container } = render(<MeterGauge meter={weekly} processId="nobody" />);
    expect(container.querySelector('[data-part="ceiling"]')).toBeNull();
  });
});
