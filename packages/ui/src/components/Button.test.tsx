import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useCan } from '../app/session.js';
import { renderWithProviders } from '../test/render.js';
import { Button } from './Button.js';
import { LinkButton } from './LinkButton.js';
import { Toggle } from './Toggle.js';

function CanProbe() {
  return <span>{useCan('operator') ? 'can operate' : 'cannot operate'}</span>;
}

describe('role gating', () => {
  it('useCan compares roles viewer < operator < admin', () => {
    renderWithProviders(<CanProbe />, { role: 'viewer' });
    expect(screen.getByText('cannot operate')).toBeInTheDocument();
  });

  it('keeps a viewer’s control visible but disabled, with a tooltip naming the role', async () => {
    const onClick = vi.fn();
    const { user } = renderWithProviders(
      <Button requires="operator" onClick={onClick}>
        Reset breaker
      </Button>,
      { role: 'viewer' },
    );
    const button = screen.getByRole('button', { name: 'Reset breaker' });
    expect(button).toBeVisible();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription('Viewer role · needs the Operator role');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('enables the control for an operator', async () => {
    const onClick = vi.fn();
    const { user } = renderWithProviders(
      <Button requires="operator" onClick={onClick}>
        Reset breaker
      </Button>,
      { role: 'operator' },
    );
    const button = screen.getByRole('button', { name: 'Reset breaker' });
    expect(button).not.toHaveAttribute('aria-disabled');
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('gates toggles the same way', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(
      <Toggle label="Enabled" value onChange={onChange} requires="operator" />,
      { role: 'viewer' },
    );
    const toggle = screen.getByRole('switch', { name: 'Enabled' });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).toHaveAccessibleDescription(/needs the Operator role/);
    await user.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('gates link buttons the same way: visible, not followed, with the role named', async () => {
    const { user, router } = renderWithProviders(
      <LinkButton to="/processes/new" requires="operator">
        New process
      </LinkButton>,
      { role: 'viewer', path: '/processes' },
    );
    const link = screen.getByRole('link', { name: 'New process' });
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(link).not.toHaveAttribute('href');
    expect(link).toHaveAccessibleDescription('Viewer role · needs the Operator role');
    await user.click(link);
    expect(router.state.location.pathname).toBe('/processes');
  });

  it('follows a link button for a role that has it', async () => {
    const { user, router } = renderWithProviders(
      <LinkButton to="/processes/new" requires="operator">
        New process
      </LinkButton>,
      { role: 'operator', path: '/processes' },
    );
    await user.click(screen.getByRole('link', { name: 'New process' }));
    expect(router.state.location.pathname).toBe('/processes/new');
  });
});
