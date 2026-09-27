import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusChip } from './StatusChip.js';

describe('StatusChip', () => {
  it.each([
    ['ok', 'healthy', '--st-ok'],
    ['warn', 'awaiting approval', '--st-warn'],
    ['error', 'breaker open', '--st-err'],
    ['off', 'disabled', '--st-off'],
  ] as const)('renders the %s tone with its word', (tone, label, token) => {
    render(<StatusChip tone={tone} label={label} />);
    const chip = screen.getByText(label);
    expect(chip).toBeVisible();
    expect(chip).toHaveAttribute('data-tone', tone);
    expect(chip.getAttribute('style')).toContain(`var(${token}-bg)`);
  });

  it('puts a count before the word', () => {
    render(<StatusChip tone="error" label="breaker open" count={1} />);
    expect(screen.getByText('breaker open')).toHaveTextContent('1breaker open');
  });
});
