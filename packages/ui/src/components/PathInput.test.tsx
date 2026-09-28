import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { samplePaths } from '../lib/suggest.js';
import { PathInput } from './PathInput.js';

const paths = samplePaths({
  body: { issue: { id: 'ISS-1', priority: 'high' } },
  headers: { 'x-event-type': 'issue.created' },
  query: {},
});

function Harness() {
  const [value, setValue] = useState('');
  return (
    <>
      <label htmlFor="p">Artifact id path</label>
      <PathInput id="p" label="Artifact id path" value={value} onChange={setValue} paths={paths} />
      <output aria-label="value">{value}</output>
    </>
  );
}

describe('PathInput', () => {
  it('suggests paths from the sample with example values as you type', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('combobox', { name: 'Artifact id path' }), 'body.issue.');
    const list = screen.getByRole('listbox', { name: 'Paths for Artifact id path' });
    const options = screen.getAllByRole('option');
    expect(list).toBeVisible();
    expect(options.map((o) => o.textContent)).toEqual([
      'body.issue.id"ISS-1"',
      'body.issue.priority"high"',
    ]);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('is keyboard accessible: arrows move, Enter picks, Escape closes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Artifact id path' });
    await user.type(input, 'body.issue.');
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      screen.getAllByRole('option')[1]?.id ?? '',
    );
    await user.keyboard('{Enter}');
    expect(screen.getByRole('status', { hidden: true, name: 'value' })).toHaveTextContent(
      'body.issue.priority',
    );
    expect(screen.queryByRole('listbox')).toBeNull();

    await user.clear(input);
    await user.type(input, 'head');
    expect(screen.getByRole('listbox')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('picks with the mouse', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Artifact id path' }));
    await user.click(screen.getByRole('option', { name: /headers\.x-event-type/ }));
    expect(screen.getByRole('status', { hidden: true, name: 'value' })).toHaveTextContent(
      'headers.x-event-type',
    );
  });
});
