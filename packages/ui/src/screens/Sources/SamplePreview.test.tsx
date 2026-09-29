import type { SourcePreviewRequest, SourcePreviewResponse } from '@ai-switchboard/core/contract';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test/render.js';
import { SourceDetail } from './SourceDetail.js';
import { Sources } from './Sources.js';

async function openWebhookForm(user: ReturnType<typeof renderWithProviders>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Add source' }));
  await user.click(
    within(await screen.findByRole('dialog', { name: 'Add a source' })).getByRole('button', {
      name: /^Webhook/,
    }),
  );
  return screen.findByRole('dialog', { name: 'New Webhook source' });
}

describe('Try it with a sample delivery', () => {
  it('in Add source, shows the events a pasted sample becomes', async () => {
    const { user, api } = renderWithProviders(<Sources />);
    const form = await openWebhookForm(user);
    const panel = within(form).getByRole('region', { name: 'Try it with a sample delivery' });
    await user.click(within(panel).getByLabelText(/^Sample body/));
    await user.paste('{"id": "dep_1", "status": "success", "count": 3}');

    const events = await within(panel).findByRole('list', { name: 'Resulting events' });
    expect(within(events).getByText('webhook.request.received')).toBeVisible();
    expect(within(events).getByText('valid')).toBeVisible();
    const attributes = within(events).getByLabelText('Attributes of event 1');
    expect(attributes).toHaveTextContent(/status\s*success/);
    expect(attributes).toHaveTextContent(/count\s*3/);
    expect(within(events).getByText(/dep_1/, { selector: 'span' })).toBeVisible();

    const sent = api.callsTo('POST /sources/preview').at(-1)?.body as SourcePreviewRequest;
    expect(sent.typeId).toBe('webhook');
    expect(sent.request.body).toBe('{"id": "dep_1", "status": "success", "count": 3}');
    expect(sent).not.toHaveProperty('sourceId');
  });

  it('re-runs as the settings change and shows errors and the plugin’s notes', async () => {
    const answer: SourcePreviewResponse = {
      events: [],
      errors: ["Settings: must have required property 'secret'"],
      notes: ['No rule matched, so this delivery produces no event.'],
      declaredTypes: [],
    };
    const { user, api } = renderWithProviders(<Sources />, {
      overrides: { 'POST /sources/preview': () => answer },
    });
    const form = await openWebhookForm(user);
    const panel = within(form).getByRole('region', { name: 'Try it with a sample delivery' });
    await user.click(within(panel).getByLabelText(/^Sample body/));
    await user.paste('{}');
    expect(await within(panel).findByText(/must have required property 'secret'/)).toBeVisible();
    expect(within(panel).getByText(/No rule matched/)).toBeVisible();

    const before = api.callsTo('POST /sources/preview').length;
    await user.click(
      within(form).getByRole('radio', {
        name: 'None — accept unauthenticated deliveries (evaluation only)',
      }),
    );
    await vi.waitFor(() => {
      expect(api.callsTo('POST /sources/preview').length).toBeGreaterThan(before);
    });
    const last = api.callsTo('POST /sources/preview').at(-1)?.body as SourcePreviewRequest;
    expect(last.settings.verification).toBe('none');
  });

  it('in Source › Settings, takes the last delivery as the sample', async () => {
    const { user, api } = renderWithProviders(<SourceDetail />, {
      path: '/sources/src-slack/settings',
      routePath: '/sources/:id/:tab',
    });
    const panel = await screen.findByRole('region', { name: 'Try it with a sample delivery' });
    await user.click(within(panel).getByRole('button', { name: 'Use the last delivery' }));
    const text = (label: RegExp): string =>
      within(panel).getByLabelText<HTMLTextAreaElement>(label, { selector: 'textarea' }).value;
    await vi.waitFor(() => {
      expect(text(/^Sample body/)).toContain('"service": "api"');
    });
    expect(text(/^Sample headers/)).toContain('x-delivery-id: 7f3a9c1e');
    await within(panel).findByRole('list', { name: 'Resulting events' });
    const sent = api.callsTo('POST /sources/preview').at(-1)?.body as SourcePreviewRequest;
    expect(sent.sourceId).toBe('src-slack');
    expect(sent.request.headers?.['x-delivery-id']).toBe('7f3a9c1e-2b44-4d0a-9d4f-8e1b2a6c5d01');
  });

  it('is disabled for viewers, who cannot run the preview', async () => {
    const { api } = renderWithProviders(<SourceDetail />, {
      path: '/sources/src-slack/settings',
      routePath: '/sources/:id/:tab',
      role: 'viewer',
    });
    const panel = await screen.findByRole('region', { name: 'Try it with a sample delivery' });
    expect(within(panel).getByLabelText(/^Sample body/)).toBeDisabled();
    expect(within(panel).getByText('Trying a sample needs the operator role.')).toBeVisible();
    expect(api.callsTo('POST /sources/preview')).toHaveLength(0);
  });
});
