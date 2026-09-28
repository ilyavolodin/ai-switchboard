import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useResetBreaker } from '../api/index.js';
import { useReasonedMutation } from '../hooks/reason.js';
import { renderWithProviders } from '../test/render.js';
import { Button } from './Button.js';
import { ReasonDialog } from './ReasonDialog.js';

describe('ReasonDialog', () => {
  it('refuses to confirm without a reason', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ReasonDialog
        open
        title="Reset the Autofix breaker?"
        consequence="Event runs resume immediately."
        confirmLabel="Reset breaker"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Reset the Autofix breaker?' });
    expect(dialog).toHaveTextContent('Event runs resume immediately.');
    await user.click(screen.getByRole('button', { name: 'Reset breaker' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('A reason is required');

    await user.type(screen.getByRole('textbox', { name: /Reason/ }), '   ');
    await user.click(screen.getByRole('button', { name: 'Reset breaker' }));
    expect(onConfirm).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox', { name: /Reason/ }), ' suite is green again ');
    await user.click(screen.getByRole('button', { name: 'Reset breaker' }));
    expect(onConfirm).toHaveBeenCalledWith('suite is green again');
  });

  it('focuses the reason field and closes on Escape', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ReasonDialog
        open
        title="Reload?"
        confirmLabel="Reload"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('textbox', { name: /Reason/ })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});

function ResetButton({ danger }: { danger?: boolean }) {
  const reset = useReasonedMutation(useResetBreaker(), {
    title: 'Reset the Autofix breaker?',
    confirmLabel: 'Reset breaker',
    ...(danger ? { danger } : {}),
  });
  return <Button onClick={() => void reset.run({ id: 'p-autofix' })}>Reset</Button>;
}

describe('useReasonedMutation', () => {
  it('asks for the reason and sends it with the mutation', async () => {
    const { user, api } = renderWithProviders(<ResetButton />);
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.type(screen.getByRole('textbox', { name: /Reason/ }), 'tests fixed in #490');
    await user.click(screen.getByRole('button', { name: 'Reset breaker' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes/p-autofix/breaker/reset')).toHaveLength(1);
    });
    expect(api.callsTo('POST /processes/p-autofix/breaker/reset')[0]?.body).toEqual({
      reason: 'tests fixed in #490',
    });
  });

  it('sends nothing when cancelled', async () => {
    const { user, api } = renderWithProviders(<ResetButton />);
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('POST /processes/p-autofix/breaker/reset')).toHaveLength(0);
  });

  it('skips the prompt when the installation does not require reasons', async () => {
    const { user, api } = renderWithProviders(<ResetButton />, { requireReasons: false });
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes/p-autofix/breaker/reset')).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('POST /processes/p-autofix/breaker/reset')[0]?.body).toEqual({
      reason: '',
    });
  });

  it('still confirms a danger action, with an optional note, when reasons are optional', async () => {
    const { user, api } = renderWithProviders(<ResetButton danger />, { requireReasons: false });
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    const dialog = screen.getByRole('dialog', { name: 'Reset the Autofix breaker?' });
    expect(screen.getByRole('textbox', { name: /Note \(optional\)/ })).not.toBeRequired();
    await user.click(screen.getByRole('button', { name: 'Reset breaker' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes/p-autofix/breaker/reset')).toHaveLength(1);
    });
    expect(dialog).not.toBeInTheDocument();
    expect(api.callsTo('POST /processes/p-autofix/breaker/reset')[0]?.body).toEqual({
      reason: '',
    });
  });
});
