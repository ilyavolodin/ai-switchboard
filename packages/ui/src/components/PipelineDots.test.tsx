import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildFixtures } from '../api/fixtures.js';
import { funnelModel } from '../lib/funnel.js';
import { TEST_NOW } from '../test/constants.js';
import { PipelineDots } from './PipelineDots.js';
import { PipelineFunnel } from './PipelineFunnel.js';
import { StageIndicator } from './StageIndicator.js';

const f = buildFixtures(TEST_NOW);

describe('PipelineDots', () => {
  it('reads five stops with counts and tones, hollow when quiet', () => {
    const { container } = render(
      <PipelineDots
        dots={{
          matched: 4,
          batched: 2,
          gated: 2,
          invoked: 0,
          ok: 0,
          tones: ['ok', 'ok', 'warn', 'off', 'off'],
        }}
      />,
    );
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Last hour: matched 4 ok, batched 2 ok, gated 2 stopped (held or throttled), invoked 0 quiet, ok 0 quiet',
    );
    const stops = container.querySelectorAll('[data-stop]');
    expect([...stops].map((s) => s.getAttribute('data-tone'))).toEqual([
      'ok',
      'ok',
      'warn',
      'off',
      'off',
    ]);
  });
});

describe('PipelineFunnel', () => {
  it('sizes stages in proportion to their counts', () => {
    const model = funnelModel(f.funnel);
    const size = Object.fromEntries(model.stages.map((s) => [s.id, s.size]));
    expect(size.matched).toBe(1);
    expect(size.deduped).toBeCloseTo(131 / 184);
    expect(size.batched).toBeCloseTo(62 / 184);
    expect(size.invoked).toBeCloseTo(56 / 184);
  });

  it('keeps sweeps as their own stream in the invoked stage', () => {
    const invoked = funnelModel(f.funnel).stages.find((s) => s.id === 'invoked');
    expect(invoked?.segments.map((s) => [s.id, s.count])).toEqual([
      ['event', 49],
      ['sweep', 7],
    ]);
    expect(invoked?.segments[1]?.share).toBeCloseTo(7 / 56);
  });

  it('renders counts, the held/throttled chip and the outcome split', () => {
    const { container } = render(<PipelineFunnel funnel={f.funnel} />);
    expect(screen.getByRole('figure')).toHaveAccessibleName(/184 events matched/);
    expect(screen.getByText('held / throttled')).toHaveTextContent('13held / throttled');
    expect(container.querySelector('[data-stage="matched"]')).toHaveAttribute('data-size', '1.000');
    expect(container.querySelector('[data-segment="sweep"]')).toHaveAttribute('title', '7 sweeps');
    expect(container.querySelector('[data-segment="ok"]')).toHaveAttribute('title', '51 ok');
  });
});

describe('StageIndicator', () => {
  it('fills passed stops, colours the one reached and leaves the rest hollow', () => {
    const { container } = render(
      <StageIndicator indicator={{ reached: 3, tone: 'warn', label: 'held at batched' }} />,
    );
    expect(screen.getByText('held at batched')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'held at batched · reached batched (3 of 5)',
    );
    expect(
      [...container.querySelectorAll('[data-stop]')].map((s) => s.getAttribute('data-state')),
    ).toEqual(['passed', 'passed', 'current', 'pending', 'pending']);
  });
});
