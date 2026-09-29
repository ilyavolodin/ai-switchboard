import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { settingsSchema } from '@ai-switchboard/source-webhook/schemas';

import type { DeliverySample } from '../lib/suggest.js';
import { SchemaForm } from './SchemaForm.js';

function Harness({
  initial = {},
  sample,
}: {
  initial?: Record<string, unknown>;
  sample?: DeliverySample;
}) {
  const [value, setValue] = useState<Record<string, unknown>>(initial);
  return (
    <>
      <SchemaForm schema={settingsSchema} value={value} onChange={setValue} sample={sample} />
      <output aria-label="settings">{JSON.stringify(value)}</output>
    </>
  );
}

const modes = () => screen.getByRole('radiogroup', { name: 'How deliveries become events' });
const QUICK = 'Quick — one event per delivery, attributes from the body (no setup)';
const MAPPED = 'Mapped — name event types and pick fields by path';
const JSONATA = 'JSONata — write a mapping expression (advanced)';

describe('SchemaForm with the webhook source schema', () => {
  it('puts Verification first as labelled choices, including no verification', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Verification' });
    const labels = [...group.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).toEqual([
      'HMAC signature over the body',
      'Shared-secret header',
      'None — accept unauthenticated deliveries (evaluation only)',
    ]);
    const fields = [...document.querySelectorAll('label, [role="radiogroup"]')];
    expect(fields.indexOf(group)).toBeLessThan(
      fields.findIndex((f) => f.textContent.startsWith('Secret')),
    );
  });

  it('with the default (hmac) requires a secret and hides the shared-secret header', () => {
    render(<Harness />);
    expect(screen.getByRole('radio', { name: 'HMAC signature over the body' })).toBeChecked();
    expect(screen.getByText(/^Secret/).closest('label')?.textContent).toMatch(/\*/);
    expect(screen.queryByText('Shared-secret header', { selector: 'label' })).toBeNull();
  });

  it('choosing none hides the secret and signature fields and warns under Verification', async () => {
    render(<Harness />);
    await userEvent.click(
      screen.getByRole('radio', {
        name: 'None — accept unauthenticated deliveries (evaluation only)',
      }),
    );
    expect(screen.queryByText(/^Secret/)).toBeNull();
    expect(screen.queryByText('Signature header')).toBeNull();
    expect(
      screen.getByText('Anyone who knows the URL can send events — evaluation only.'),
    ).toBeVisible();
  });
});

describe('SchemaForm with the webhook mapping modes', () => {
  it('starts a new instance on Quick, showing only the quick fields', () => {
    render(<Harness />);
    expect(within(modes()).getByRole('radio', { name: QUICK })).toBeChecked();
    expect(screen.getByText('Event type', { selector: 'label' })).toBeVisible();
    expect(screen.getByText('Artifact id path', { selector: 'label' })).toBeVisible();
    expect(screen.queryByText('Mapping', { selector: 'label' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();
    // Nothing is written until the person chooses: an unset mode stays unset.
    expect(screen.getByRole('status', { name: 'settings' })).not.toHaveTextContent('mappingMode');
  });

  it('shows an instance saved before the modes (a mapping, no mode) as JSONata', () => {
    render(<Harness initial={{ verification: 'none', mapping: 'body' }} />);
    expect(within(modes()).getByRole('radio', { name: JSONATA })).toBeChecked();
    expect(screen.getByText('Mapping', { selector: 'label' })).toBeVisible();
    expect(screen.queryByText('Artifact id path', { selector: 'label' })).toBeNull();
    expect(screen.getByRole('link', { name: 'JSONata documentation' })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('switching to Mapped shows rules, and a rule’s paths suggest from the sample', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ verification: 'none' }}
        sample={{
          body: { issue: { id: 'ISS-1' } },
          headers: { 'x-event-type': 'issue.created' },
          query: {},
        }}
      />,
    );
    await user.click(within(modes()).getByRole('radio', { name: MAPPED }));
    expect(screen.queryByText('Event type', { selector: 'label' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByRole('group', { name: 'Rule 1' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Only when' })).toBeVisible();
    const idPath = screen.getByRole('combobox', { name: /Artifact id path/ });
    await user.type(idPath, 'body.iss');
    await user.click(screen.getByRole('option', { name: /body\.issue\.id/ }));
    expect(idPath).toHaveValue('body.issue.id');
    expect(screen.getByRole('status', { name: 'settings' })).toHaveTextContent(
      '"mappingMode":"mapped"',
    );
  });

  it('switching to JSONata shows the event types and the mapping', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ verification: 'none' }} />);
    await user.click(within(modes()).getByRole('radio', { name: JSONATA }));
    expect(screen.getByText('Mapping', { selector: 'label' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add event type' })).toBeVisible();
  });
});
