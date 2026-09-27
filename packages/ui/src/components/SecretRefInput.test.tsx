import type { Role } from '@ai-switchboard/core/contract';
import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../test/render.js';
import { SecretRefInput } from './SecretRefInput.js';

let latest: string | undefined;

function Harness({ initial }: { initial?: string }) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <SecretRefInput
      label="API key"
      value={value}
      providers={['env', 'file']}
      onChange={(next) => {
        latest = next;
        setValue(next);
      }}
    />
  );
}

const suggestions = (input: HTMLElement): string[] =>
  [...((input as HTMLInputElement).list?.options ?? [])].map((o) => o.value);

const renderAs = (role: Role, initial?: string) =>
  renderWithProviders(<Harness initial={initial} />, { role });

describe('SecretRefInput suggestions', () => {
  it('offers the names the chosen provider lists, and still takes free typing', async () => {
    const { user, api } = renderAs('admin');
    const input = await screen.findByRole('combobox', { name: 'API key name' });
    await user.click(input);
    await vi.waitFor(() => {
      expect(suggestions(input)).toContain('LINEAR_API_KEY');
    });
    expect(suggestions(input)).toContain('SLACK_WEBHOOK_URL');
    expect(api.callsTo('GET /secret-providers/sp-env/secrets')).toHaveLength(1);

    await user.type(input, 'BRAND_NEW');
    expect(latest).toBe('secret://env/BRAND_NEW');
    expect(screen.getByText(/not found in env/)).toBeInTheDocument();
  });

  it('does not flag a listed name', async () => {
    renderAs('admin', 'secret://env/LINEAR_API_KEY');
    const input = await screen.findByRole('combobox', { name: 'API key name' });
    await vi.waitFor(() => {
      expect(suggestions(input)).toContain('LINEAR_API_KEY');
    });
    expect(screen.queryByText(/not found in/)).not.toBeInTheDocument();
    expect(screen.getByText(/value never shown/)).toBeInTheDocument();
  });

  it('switches suggestions with the provider', async () => {
    const { user } = renderAs('admin', 'secret://env/LINEAR_API_KEY');
    await user.selectOptions(screen.getByRole('combobox', { name: 'API key provider' }), 'file');
    expect(latest).toBe('secret://file/LINEAR_API_KEY');
    const input = await screen.findByRole('combobox', { name: 'API key name' });
    await vi.waitFor(() => {
      expect(suggestions(input)).toEqual(['github-app-key']);
    });
    expect(screen.getByText(/not found in file/)).toBeInTheDocument();
  });

  it('asks nothing and flags nothing for a non-admin', () => {
    const { api } = renderAs('operator', 'secret://env/ANYTHING');
    expect(screen.getByRole('textbox', { name: 'API key name' })).toHaveValue('ANYTHING');
    expect(screen.queryByText(/not found in/)).not.toBeInTheDocument();
    expect(api.callsTo('GET /secret-providers/sp-env/secrets')).toHaveLength(0);
  });

  it('works outside a query client (plain text input, no suggestions)', () => {
    render(<Harness initial="secret://env/X" />);
    expect(screen.getByRole('textbox', { name: 'API key name' })).toHaveValue('X');
  });
});
