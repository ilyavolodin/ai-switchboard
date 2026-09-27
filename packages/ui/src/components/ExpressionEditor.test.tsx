import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { type EvaluationRow, ExpressionEditor } from './ExpressionEditor.js';

const row = (id: string, result: boolean, error?: string): EvaluationRow => ({
  eventId: `ev-${id}`,
  type: 'issue.label_added',
  occurredAt: '2026-09-27T07:37:00Z',
  artifact: { kind: 'linear.issue', id, url: `https://linear.app/lola/issue/${id}` },
  attributes: { label: 'autofix' },
  result,
  ...(error ? { error } : {}),
});

const rows = [
  row('LOL-1712', true),
  row('LOL-1709', false),
  row('LOL-1701', true),
  row('LOL-1699', true),
  row('LOL-1716', false, '$resolve timed out'),
];

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ExpressionEditor
        label="Filter expression"
        value={value}
        onChange={setValue}
        rows={rows}
        insertions={[{ label: 'attributes.label', title: 'string · the label added' }]}
      />
      <output aria-label="current value">{value}</output>
    </>
  );
}

describe('ExpressionEditor', () => {
  it('summarises the live evaluation as true, false and error counts', () => {
    render(<Harness />);
    const panel = screen.getByRole('region', { name: 'Live evaluation' });
    expect(panel).toHaveTextContent('3 true · 1 false · 1 error');
  });

  it('renders one row per event, green true, grey false, and errors with their message', () => {
    render(<Harness />);
    const items = within(screen.getByRole('region', { name: 'Live evaluation' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveAttribute('data-result', 'true');
    expect(items[1]).toHaveAttribute('data-result', 'false');
    expect(items[4]).toHaveAttribute('data-result', 'error');
    expect(within(items[4]!).getByText('$resolve timed out')).toBeInTheDocument();
    expect(within(items[0]!).getByRole('link', { name: /LOL-1712/ })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('is controlled and inserts declared attributes at the cursor', async () => {
    const user = userEvent.setup();
    render(<Harness initial="" />);
    const box = screen.getByRole('textbox', { name: 'Filter expression' });
    await user.type(box, " = 'autofix'");
    await user.click(box);
    (box as HTMLTextAreaElement).setSelectionRange(0, 0);
    await user.click(screen.getByRole('button', { name: 'attributes.label' }));
    expect(screen.getByRole('status', { name: 'current value' })).toHaveTextContent(
      "attributes.label = 'autofix'",
    );
  });

  it('hides "show all" until there are more rows than fit', () => {
    render(
      <ExpressionEditor
        label="Filter"
        value=""
        onChange={() => undefined}
        rows={rows}
        visibleRows={3}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'show all 5' })).toBeInTheDocument();
  });
});
