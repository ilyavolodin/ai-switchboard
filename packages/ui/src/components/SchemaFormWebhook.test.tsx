import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { settingsSchema } from '../../../../plugins/source-webhook/src/settings.js';
import { SchemaForm } from './SchemaForm.js';

function Harness() {
  const [value, setValue] = useState<Record<string, unknown>>({});
  return <SchemaForm schema={settingsSchema} value={value} onChange={setValue} />;
}

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
