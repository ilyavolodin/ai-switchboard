import type { UpdateProcessRequest } from '@ai-switchboard/core/contract';
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockStatus } from '../../api/mockApi.js';
import { renderWithProviders } from '../../test/render.js';
import { ProcessEditor } from './ProcessEditor.js';

const editAutofix = { path: '/processes/p-autofix/edit', routePath: '/processes/:id/edit' };

async function loaded() {
  return screen.findByRole('region', { name: 'Triggers' });
}

async function saveWithReason(
  user: ReturnType<typeof renderWithProviders>['user'],
  reason: string,
) {
  await user.click(screen.getByRole('button', { name: 'Save' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), reason);
  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
}

describe('ProcessEditor', () => {
  it('draws the process as a diagram that follows the edits', async () => {
    const { user } = renderWithProviders(<ProcessEditor />, editAutofix);
    await loaded();
    const diagram = screen.getByRole('figure', { name: 'Process diagram' });
    expect(within(diagram).getByText('Linear — lola')).toBeInTheDocument();
    expect(
      within(diagram).getByText('issue.label_added · issue.state_changed'),
    ).toBeInTheDocument();
    expect(within(diagram).getByText('batch 90 s')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Batching/ }));
    const debounce = screen.getByRole('textbox', { name: /^Debounce/ });
    await user.clear(debounce);
    await user.type(debounce, '30');
    expect(within(diagram).getByText('batch 30 s')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^10 events become \d+ runs?/ })).toBeInTheDocument();
  });

  it('shows the declared event types when a trigger is added', async () => {
    const { user } = renderWithProviders(<ProcessEditor />, editAutofix);
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Add trigger' }));
    const trigger = screen.getByRole('group', { name: 'Trigger 3' });
    await user.selectOptions(
      within(trigger).getByRole('combobox', { name: 'Source' }),
      'src-linear',
    );

    const types = await within(trigger).findByRole('group', { name: 'Event types' });
    const labelled = within(types).getByRole('checkbox', { name: 'issue.label_added' });
    expect(within(types).getByRole('checkbox', { name: 'issue.state_changed' })).not.toBeChecked();
    await user.click(labelled);
    expect(labelled).toBeChecked();
    expect(within(trigger).getByRole('textbox', { name: /^Describe/ })).toHaveValue(
      'Linear: Issue labelled',
    );
    expect(within(trigger).getByRole('button', { name: 'attributes.label' })).toBeInTheDocument();
    expect(await within(trigger).findByText('Examples from the manifest')).toBeInTheDocument();
  });

  it('evaluates the filter live against recent real events', async () => {
    const { api, user } = renderWithProviders(<ProcessEditor />, editAutofix);
    await loaded();
    const trigger = screen.getByRole('group', { name: 'Trigger 1' });
    const live = await within(trigger).findByRole('region', { name: 'Live evaluation' });
    await vi.waitFor(() => {
      expect(within(live).getAllByRole('listitem')).toHaveLength(5);
    });
    expect(within(live).getByText('3 true')).toBeInTheDocument();
    const rows = within(live).getAllByRole('listitem');
    expect(rows.filter((r) => r.dataset.result === 'true')).toHaveLength(3);
    expect(rows.filter((r) => r.dataset.result === 'false')).toHaveLength(2);
    expect(api.callsTo('POST /processes/preview/filter')[0]?.body).toEqual({
      sourceId: 'src-linear',
      eventTypes: ['issue.label_added', 'issue.state_changed'],
      filter: "attributes.label = 'autofix' and 'complexity:simple' in $resolve(artifact).labels",
      limit: 20,
    });

    const filter = within(trigger).getByRole('textbox', { name: /^Filter/ });
    await user.clear(filter);
    await user.type(filter, "attributes.label = 'bug'");
    await vi.waitFor(() => {
      const bodies = api.callsTo('POST /processes/preview/filter').map((c) => c.body);
      expect(bodies).toContainEqual(
        expect.objectContaining({ filter: "attributes.label = 'bug'" }),
      );
    });
  });

  it('saves with a reason and the version it was edited from', async () => {
    const { api, user, router } = renderWithProviders(<ProcessEditor />, editAutofix);
    await loaded();
    const name = screen.getByRole('textbox', { name: /^Name/ });
    await user.clear(name);
    await user.type(name, 'Autofix v2');
    const footer = screen.getByRole('region', { name: 'Save changes' });
    expect(within(footer).getByText('1 unsaved change')).toBeInTheDocument();
    expect(within(footer).getByText('name Autofix → Autofix v2')).toBeInTheDocument();

    await saveWithReason(user, 'rename for the v2 routine');
    await vi.waitFor(() => {
      expect(api.callsTo('PUT /processes/p-autofix')).toHaveLength(1);
    });
    const body = api.callsTo('PUT /processes/p-autofix')[0]?.body as UpdateProcessRequest;
    expect(body.reason).toBe('rename for the v2 routine');
    expect(body.expectedVersion).toBe(12);
    expect(body.document.name).toBe('Autofix v2');
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/processes/p-autofix');
    });
  });

  it('explains a version conflict instead of overwriting', async () => {
    const { user, router } = renderWithProviders(<ProcessEditor />, {
      ...editAutofix,
      overrides: {
        'PUT /processes/:id': () =>
          mockStatus(409, { error: 'version_conflict', message: 'expected version 12, found 13' }),
      },
    });
    await loaded();
    const name = screen.getByRole('textbox', { name: /^Name/ });
    await user.type(name, '!');
    await saveWithReason(user, 'tweak');
    expect(
      await screen.findByText('Someone else saved this process while you were editing'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing was saved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep my changes' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/processes/p-autofix/edit');
  });

  it('shows validation details from the API in the section they belong to', async () => {
    const { user } = renderWithProviders(<ProcessEditor />, {
      ...editAutofix,
      overrides: {
        'PUT /processes/:id': () =>
          mockStatus(422, {
            error: 'invalid_document',
            message: 'The process document is invalid',
            details: ['/budgets/runsPerHour must be >= 0'],
          }),
      },
    });
    await loaded();
    await user.type(screen.getByRole('textbox', { name: /^Name/ }), '!');
    await saveWithReason(user, 'tweak');
    const budgets = screen.getByRole('region', { name: 'Budgets' });
    expect(await within(budgets).findByText('Budgets needs attention')).toBeInTheDocument();
    expect(within(budgets).getByText('/budgets/runsPerHour must be >= 0')).toBeInTheDocument();
    expect(within(budgets).getByText('must be >= 0')).toBeInTheDocument();
  });

  it('previews a schedule in plain language with the next three sweeps', async () => {
    const { api, user } = renderWithProviders(<ProcessEditor />, editAutofix);
    await loaded();
    await user.click(screen.getByRole('button', { name: /^Schedules/ }));
    const schedules = screen.getByRole('region', { name: 'Schedules' });
    expect(within(schedules).getByText('At 07:00')).toBeInTheDocument();
    const next = await within(schedules).findByRole('list', { name: 'Next three runs' });
    expect(within(next).getAllByRole('listitem')).toHaveLength(3);
    expect(api.callsTo('POST /processes/preview/cron')[0]?.body).toEqual({
      cron: '0 7 * * *',
      timezone: 'America/New_York',
    });
  });

  it('draws per-meter ceilings as marks on each gauge', async () => {
    const { user } = renderWithProviders(<ProcessEditor />, editAutofix);
    await loaded();
    await user.click(screen.getByRole('button', { name: /^Budgets/ }));
    const budgets = screen.getByRole('region', { name: 'Budgets' });
    const gauge = await within(budgets).findByRole('img', { name: /^5-hour window .*ceiling 85%/ });
    expect(gauge.querySelector('[data-part="ceiling"]')).toHaveAttribute('data-percent', '85');
    expect(gauge.querySelector('[data-part="sweep-ceiling"]')).toHaveAttribute(
      'data-percent',
      '95',
    );

    const input = within(budgets).getByRole('textbox', { name: '5-hour window event ceiling' });
    await user.clear(input);
    await user.type(input, '70');
    const updated = within(budgets).getByRole('img', { name: /^5-hour window .*ceiling 70%/ });
    expect(updated.querySelector('[data-part="ceiling"]')).toHaveAttribute('data-percent', '70');
    expect(
      within(screen.getByRole('region', { name: 'Save changes' })).getByText(
        'ceiling five_hour events 85 → 70',
      ),
    ).toBeInTheDocument();
    expect(within(budgets).getByRole('textbox', { name: /^input_tokens \/ day/ })).toHaveValue(
      '400000',
    );
  });

  it('starts a dry test run with a chosen recent batch', async () => {
    const { api, user } = renderWithProviders(<ProcessEditor />, editAutofix);
    await loaded();
    const footer = screen.getByRole('region', { name: 'Save changes' });
    await vi.waitFor(() => {
      expect(within(footer).getByRole('combobox', { name: 'Test batch' })).toHaveValue(
        'b-autofix-0736',
      );
    });
    await user.click(within(footer).getByRole('button', { name: 'Test run' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'try the new mapping');
    await user.click(within(dialog).getByRole('button', { name: 'Start test run' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes/p-autofix/run')[0]?.body).toEqual({
        dryRun: true,
        batchId: 'b-autofix-0736',
        reason: 'try the new mapping',
      });
    });
  });

  it('checks a new process before asking for a reason', async () => {
    const { api, user } = renderWithProviders(<ProcessEditor />, {
      path: '/processes/new',
      routePath: '/processes/new',
    });
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Create process' }));
    expect(await screen.findByText('A process needs a name')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'Nightly digest');
    await user.click(screen.getByRole('button', { name: 'Create process' }));
    const dialog = await screen.findByRole('dialog');
    // A new process starts enabled, and the prompt says so.
    expect(within(dialog).getByText(/created enabled/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'new digest');
    await user.click(within(dialog).getByRole('button', { name: 'Create process' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes')).toHaveLength(1);
    });
    expect(api.callsTo('POST /processes')[0]?.body).toMatchObject({
      reason: 'new digest',
      document: {
        name: 'Nightly digest',
        enabled: true,
        destination: { instanceId: 'ex-routines' },
      },
    });
  });

  it('enables and disables an existing process from the Basics section', async () => {
    const { api, user } = renderWithProviders(<ProcessEditor />, editAutofix);
    await loaded();
    const basics = screen.getByRole('region', { name: 'Basics' });
    const toggle = within(basics).getByRole('switch', { name: 'Enabled' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(within(basics).getByText(/no event or sweep starts it/)).toBeInTheDocument();
    const footer = screen.getByRole('region', { name: 'Save changes' });
    expect(within(footer).getByText('1 unsaved change')).toBeInTheDocument();
    await saveWithReason(user, 'pause while the routine is fixed');
    await vi.waitFor(() => {
      expect(api.callsTo('PUT /processes/p-autofix')).toHaveLength(1);
    });
    const body = api.callsTo('PUT /processes/p-autofix')[0]?.body as UpdateProcessRequest;
    expect(body.document.enabled).toBe(false);
  });

  it('asks before leaving with unsaved changes, and lets a clean editor go', async () => {
    const { user, router } = renderWithProviders(<ProcessEditor />, editAutofix);
    await loaded();
    await user.type(screen.getByRole('textbox', { name: /^Name/ }), '!');

    await act(() => router.navigate('/processes'));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    expect(within(dialog).getByText(/1 unsaved change/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(router.state.location.pathname).toBe('/processes/p-autofix/edit');
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Autofix!');

    await act(() => router.navigate('/processes'));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Leave without saving',
      }),
    );
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/processes');
    });
  });

  it('leaves without asking once the changes are discarded', async () => {
    const { user, router } = renderWithProviders(<ProcessEditor />, editAutofix);
    await loaded();
    await user.type(screen.getByRole('textbox', { name: /^Name/ }), '!');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await act(() => router.navigate('/processes'));
    expect(router.state.location.pathname).toBe('/processes');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps Save and Test run visible but disabled for viewers', async () => {
    renderWithProviders(<ProcessEditor />, { ...editAutofix, role: 'viewer' });
    await loaded();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Test run' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Read only')).toBeInTheDocument();
  });

  it('says so when the process to edit does not exist', async () => {
    renderWithProviders(<ProcessEditor />, {
      path: '/processes/nope/edit',
      routePath: '/processes/:id/edit',
    });
    expect(await screen.findByText('This process does not exist')).toBeInTheDocument();
  });
});
