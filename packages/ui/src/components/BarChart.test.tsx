import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BarChart } from './BarChart.js';
import { Sparkline } from './Sparkline.js';

describe('BarChart', () => {
  it.each([false, true])(
    'draws no NaN geometry for missing or invalid values (stacked %s)',
    (stacked) => {
      const { container } = render(
        <BarChart
          ariaLabel="Runs per day"
          labels={['Mon', 'Tue', 'Wed']}
          stacked={stacked}
          series={[
            { id: 'ok', label: 'ok', color: 'var(--st-ok)', values: [2, Number.NaN, 4] },
            { id: 'error', label: 'error', color: 'var(--st-err)', values: [-1, 1] },
          ]}
        />,
      );
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
      expect(screen.getByRole('img', { name: 'Runs per day' })).toBeInTheDocument();
    },
  );

  it('draws an empty chart for all-zero data', () => {
    const { container } = render(
      <BarChart
        ariaLabel="Events"
        labels={['Mon', 'Tue']}
        series={[{ id: 'a', label: 'a', color: 'var(--primary)', values: [0, 0] }]}
      />,
    );
    expect(container.innerHTML).not.toMatch(/NaN/);
  });
});

describe('Sparkline', () => {
  it('draws a single value as a flat line across the width', () => {
    render(<Sparkline values={[3]} label="Runs" width={72} />);
    const line = screen.getByRole('img', { name: 'Runs: 3' }).querySelector('polyline');
    const points = (line?.getAttribute('points') ?? '').split(' ');
    expect(points).toHaveLength(2);
    expect(points[1]?.startsWith('72.0,')).toBe(true);
  });

  it('treats invalid values as zero', () => {
    const { container } = render(<Sparkline values={[1, Number.NaN, 2]} />);
    expect(container.querySelector('polyline')?.getAttribute('points')).not.toMatch(/NaN/);
  });
});
