import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from './Dialog.js';
import { Drawer } from './Drawer.js';

describe('Dialog', () => {
  it('closes only the topmost of two stacked dialogs on Escape', async () => {
    const user = userEvent.setup();
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <Dialog open title="Edit source" onClose={closeOuter}>
          <input aria-label="Name" />
        </Dialog>
        <Dialog open title="Why?" onClose={closeInner}>
          <input aria-label="Reason" />
        </Dialog>
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Reason' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(closeInner).toHaveBeenCalledOnce();
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it('keeps Tab inside a dialog with nothing focusable', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Behind</button>
        <Dialog open title="Nothing to do" onClose={() => undefined}>
          Just text.
        </Dialog>
      </>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Behind' })).not.toHaveFocus();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });
});

describe('Drawer', () => {
  it('keeps Tab inside the drawer', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Behind</button>
        <Drawer open title="Run detail" onClose={() => undefined}>
          <button type="button">Close run</button>
        </Drawer>
      </>,
    );
    const drawer = screen.getByRole('dialog', { name: 'Run detail' });
    for (let i = 0; i < 4; i++) {
      await user.tab();
      expect(drawer.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(drawer.contains(document.activeElement)).toBe(true);
  });

  it('leaves Escape to a dialog opened over it', async () => {
    const user = userEvent.setup();
    const closeDrawer = vi.fn();
    const closeDialog = vi.fn();
    render(
      <>
        <Drawer open title="Notifier" onClose={closeDrawer}>
          <button type="button">Save</button>
        </Drawer>
        <Dialog open title="Why?" onClose={closeDialog}>
          <input aria-label="Reason" />
        </Dialog>
      </>,
    );
    await user.keyboard('{Escape}');
    expect(closeDialog).toHaveBeenCalledOnce();
    expect(closeDrawer).not.toHaveBeenCalled();
  });
});
