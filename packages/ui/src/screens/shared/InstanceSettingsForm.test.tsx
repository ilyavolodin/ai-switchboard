import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { JSONSchema } from '@ai-switchboard/core/contract';

import { renderWithProviders } from '../../test/render.js';
import { type InstanceSettingsEntity, InstanceSettingsForm } from './InstanceSettingsForm.js';
import type { InstanceSettingsDraft } from './instanceSettings.js';

interface Caps {
  eventCapPerHour?: number;
  unauthenticated?: boolean;
}

type Entity = InstanceSettingsEntity<Caps>;
type OnSave = (draft: InstanceSettingsDraft<Caps>) => Promise<Entity | null>;

const schema: JSONSchema = {
  type: 'object',
  properties: { path: { type: 'string', title: 'Path' } },
  required: ['path'],
};

function entity(patch: Partial<Entity> = {}): Entity {
  return {
    id: 'src-hook',
    name: 'Hook',
    typeName: 'Webhook',
    settings: { path: 'a' },
    settingsSchema: schema,
    secretRefs: [],
    caps: { eventCapPerHour: 5, unauthenticated: false },
    ...patch,
  };
}

/** Each "Refetch" click hands the form the next entity, as a query refetch would. */
function Harness({ entities, onSave }: { entities: Entity[]; onSave: OnSave }) {
  const [index, setIndex] = useState(0);
  const current = entities[Math.min(index, entities.length - 1)] ?? entity();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setIndex((i) => i + 1);
        }}
      >
        Refetch
      </button>
      <InstanceSettingsForm<Caps>
        entity={current}
        kind="source"
        renderCaps={(caps, onChange) => (
          <button
            type="button"
            onClick={() => {
              onChange({ ...caps, unauthenticated: !caps.unauthenticated });
            }}
          >
            Toggle unauthenticated
          </button>
        )}
        onSave={onSave}
        saving={false}
        deletion={{ run: () => Promise.resolve(null), pending: false, blocked: null }}
        deleteNote=""
        afterDelete="/sources"
      />
    </>
  );
}

function renderForm(entities: Entity[], onSave: OnSave = () => Promise.resolve(null)) {
  return renderWithProviders(<Harness entities={entities} onSave={onSave} />);
}

const nameBox = () => screen.getByRole('textbox', { name: /^Name/ });
const pathBox = () => screen.getByRole('textbox', { name: /^Path/ });
const saveBar = () => screen.getByRole('region', { name: 'Save settings' });

describe('InstanceSettingsForm', () => {
  it('adopts a refetch while clean', async () => {
    const { user } = renderForm([entity(), entity({ settings: { path: 'b' } })]);
    await user.click(screen.getByRole('button', { name: 'Refetch' }));
    expect(pathBox()).toHaveValue('b');
    expect(saveBar()).toHaveTextContent('No unsaved changes');
  });

  it('keeps the old saved values as the baseline when a refetch arrives while it has edits', async () => {
    const { user } = renderForm([entity(), entity({ name: 'Theirs', settings: { path: 'b' } })]);
    await user.clear(pathBox());
    await user.type(pathBox(), 'mine');
    await user.click(screen.getByRole('button', { name: 'Refetch' }));
    expect(nameBox()).toHaveValue('Hook');
    expect(pathBox()).toHaveValue('mine');
    expect(saveBar()).toHaveTextContent('1 unsaved change');

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(nameBox()).toHaveValue('Hook');
    expect(pathBox()).toHaveValue('a');
    expect(saveBar()).toHaveTextContent('No unsaved changes');
  });

  it("resets from the server's response after a save", async () => {
    const onSave = vi.fn<OnSave>(() =>
      Promise.resolve(entity({ name: 'Hook (normalised)', settings: { path: 'server' } })),
    );
    const { user } = renderForm([entity()], onSave);
    await user.clear(pathBox());
    await user.type(pathBox(), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({
      name: 'Hook',
      settings: { path: 'mine' },
      caps: { eventCapPerHour: 5 },
    });
    expect(nameBox()).toHaveValue('Hook (normalised)');
    expect(pathBox()).toHaveValue('server');
    expect(saveBar()).toHaveTextContent('No unsaved changes');
  });

  it('does not count the derived unauthenticated cap as an edit', async () => {
    const { user } = renderForm([entity(), entity({ settings: { path: 'b' } })]);
    await user.click(screen.getByRole('button', { name: 'Toggle unauthenticated' }));
    expect(saveBar()).toHaveTextContent('No unsaved changes');
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Refetch' }));
    expect(pathBox()).toHaveValue('b');
  });

  it('clears the attempted errors when it adopts a refetch', async () => {
    const { user } = renderForm([
      entity({ settings: {} }),
      entity({ name: 'Theirs', settings: {} }),
    ]);
    await user.type(nameBox(), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Some fields need attention')).toBeVisible();

    await user.clear(nameBox());
    await user.type(nameBox(), 'Hook');
    expect(saveBar()).toHaveTextContent('No unsaved changes');
    expect(screen.getByText('Some fields need attention')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Refetch' }));
    expect(nameBox()).toHaveValue('Theirs');
    expect(screen.queryByText('Some fields need attention')).toBeNull();
  });
});
