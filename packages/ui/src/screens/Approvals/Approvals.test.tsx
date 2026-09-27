import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderApp, renderWithProviders } from '../../test/render.js';
import { Approvals } from './Approvals.js';

describe('Approvals', () => {
  it('lists each waiting batch with its events, rule, wait and input', async () => {
    const { user } = renderWithProviders(<Approvals />, { path: '/approvals' });
    const queue = await screen.findByRole('list', { name: 'Batches waiting' });
    const cards = within(queue).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(screen.getByText('2 waiting')).toBeVisible();

    const card = within(queue).getByRole('listitem', { name: 'Merge batch b-merge-483' });
    expect(within(card).getByRole('link', { name: 'Merge' })).toHaveAttribute(
      'href',
      '/processes/p-merge',
    );
    expect(within(card).getByRole('link', { name: /#483/ })).toHaveAttribute(
      'href',
      '/activity/trace/483',
    );
    expect(within(card).getByRole('link', { name: /#484/ })).toBeVisible();
    expect(within(card).getByText('approval: always')).toBeVisible();
    expect(within(card).getByText('6 min ago')).toBeVisible();

    const input = within(card).getByText('Input that would be sent');
    expect(within(card).getByLabelText('Input for Merge')).not.toBeVisible();
    await user.click(input);
    expect(within(card).getByLabelText('Input for Merge')).toHaveTextContent('"#483"');
  });

  it('approves with a reason', async () => {
    const { user, api } = renderWithProviders(<Approvals />, { path: '/approvals' });
    await user.click(
      await screen.findByRole('button', { name: 'Approve Merge batch b-merge-480' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Approve the Merge batch?' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'checks are green');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /approvals/b-merge-480/approve')[0]?.body).toEqual({
        reason: 'checks are green',
      });
    });
  });

  it('rejects with a reason', async () => {
    const { user, api } = renderWithProviders(<Approvals />, { path: '/approvals' });
    await user.click(await screen.findByRole('button', { name: 'Reject Merge batch b-merge-483' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject the Merge batch?' });
    expect(dialog).toHaveTextContent('The batch is dropped and never runs.');
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'touches billing');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /approvals/b-merge-483/reject')[0]?.body).toEqual({
        reason: 'touches billing',
      });
    });
  });

  it('keeps the buttons visible but disabled for a viewer', async () => {
    const { user, api } = renderWithProviders(<Approvals />, {
      path: '/approvals',
      role: 'viewer',
    });
    const approve = await screen.findByRole('button', { name: 'Approve Merge batch b-merge-480' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    await user.click(approve);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.callsTo('POST /approvals/b-merge-480/approve')).toHaveLength(0);
  });

  it('says which processes have approval rules when nothing is waiting', async () => {
    renderWithProviders(<Approvals />, {
      path: '/approvals',
      overrides: { 'GET /approvals': () => [] },
    });
    expect(await screen.findByText('Nothing is waiting for approval')).toBeVisible();
    const rules = await screen.findByRole('list', { name: 'Processes with approval rules' });
    expect(within(rules).getByRole('link', { name: 'Merge' })).toHaveAttribute(
      'href',
      '/processes/p-merge',
    );
    expect(within(rules).getByRole('link', { name: 'Dep Bumps' })).toBeVisible();
    expect(within(rules).getByText('approval: attributes.files > 20')).toBeVisible();
  });

  it('explains how to add a rule when no process has one', async () => {
    renderWithProviders(<Approvals />, {
      path: '/approvals',
      overrides: {
        'GET /approvals': () => [],
        'GET /approvals/rules': () => ({ processes: [] }),
      },
    });
    expect(await screen.findByText(/No process has an approval rule/)).toBeVisible();
  });

  it('shows recent decisions with who decided and why', async () => {
    renderWithProviders(<Approvals />, { path: '/approvals' });
    const table = await screen.findByRole('table', { name: 'Approval decisions' });
    const rejected = within(table).getByRole('row', { name: /#471/ });
    expect(rejected).toHaveTextContent('rejected');
    expect(rejected).toHaveTextContent('priya@lola.com');
    expect(rejected).toHaveTextContent('touches billing; wait for the gate change');
  });

  it('is routed at /approvals', async () => {
    renderApp('/approvals');
    expect(await screen.findByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();
    expect(await screen.findByRole('list', { name: 'Batches waiting' })).toBeVisible();
  });
});
