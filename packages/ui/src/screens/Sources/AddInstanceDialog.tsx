import type { PluginTypeDTO } from '@ai-switchboard/core/contract';
import { type ReactNode, useState } from 'react';

import { useSecretProviders } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { Skeleton } from '../../components/Skeleton.js';
import { TextField } from '../../components/TextField.js';
import { asRecord, secretProviderIds, typeIcon } from '../../lib/instances.js';
import { schemaDefaults, validateAgainstSchema } from '../../lib/schema.js';
import styles from './forms.module.css';

/** What the dialog hands back when the person presses Create. */
export interface InstanceDraft<C> {
  type: PluginTypeDTO;
  name: string;
  settings: Record<string, unknown>;
  caps: C;
}

export interface AddInstanceDialogProps<C> {
  open: boolean;
  onClose: () => void;
  kind: 'source' | 'executor';
  /** Installed types of this kind (`usePluginTypes(kind)`). */
  types: PluginTypeDTO[] | undefined;
  loading?: boolean;
  /** Initial core caps for a type. */
  initialCaps: (type: PluginTypeDTO) => C;
  /** The core caps block for the chosen type. */
  renderCaps: (type: PluginTypeDTO, caps: C, onChange: (next: C) => void) => ReactNode;
  /** One line under a type's name in the picker ("push · 4 event types"). */
  describeType: (type: PluginTypeDTO) => string;
  /** Sends the create request (asks for a reason); resolves true when it was created. */
  onSubmit: (draft: InstanceDraft<C>) => Promise<boolean>;
}

/**
 * "Add source" / "Add executor": pick an installed type, then name the instance and fill the
 * plugin's settings form (rendered from its `settingsSchema`, secrets as `secret://` references)
 * plus the core's caps. The form is kept while the reason prompt is open, so cancelling it
 * returns here with nothing lost.
 */
export function AddInstanceDialog<C>({
  open,
  onClose,
  kind,
  types,
  loading,
  initialCaps,
  renderCaps,
  describeType,
  onSubmit,
}: AddInstanceDialogProps<C>) {
  const secretProviders = useSecretProviders();
  const [type, setType] = useState<PluginTypeDTO | null>(null);
  const [name, setName] = useState('');
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [caps, setCaps] = useState<C | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = (t: PluginTypeDTO) => {
    setType(t);
    setName(t.displayName);
    setSettings(asRecord(schemaDefaults(t.settingsSchema)));
    setCaps(initialCaps(t));
    setAttempted(false);
  };
  const reset = () => {
    setType(null);
    setName('');
    setSettings({});
    setCaps(null);
    setAttempted(false);
  };

  const errors = type ? validateAgainstSchema(type.settingsSchema, settings) : {};
  const invalid = Object.keys(errors).length > 0 || name.trim() === '';
  const noun = kind === 'source' ? 'source' : 'executor';

  const submit = async () => {
    if (!type || caps === null) return;
    if (invalid) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    const ok = await onSubmit({ type, name: name.trim(), settings, caps });
    setBusy(false);
    if (ok) reset();
  };

  const installed = types ?? [];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="wide"
      dismissible={false}
      title={
        type ? `New ${type.displayName} ${noun}` : `Add ${kind === 'source' ? 'a' : 'an'} ${noun}`
      }
      footer={
        <div className={styles.footer}>
          {type && (
            <Button variant="ghost" icon="back" onClick={reset}>
              Choose another type
            </Button>
          )}
          <span className={styles.spacer} />
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {type && (
            <Button
              variant="primary"
              requires="operator"
              loading={busy}
              onClick={() => void submit()}
            >
              Create {noun}
            </Button>
          )}
        </div>
      }
    >
      {!type ? (
        loading ? (
          <Skeleton lines={3} height={48} label={`Loading ${noun} types`} />
        ) : installed.length === 0 ? (
          <EmptyState title={`No ${noun} types are installed`} compact>
            {kind === 'source' ? 'Source' : 'Executor'} types come from plugins. An admin can add
            one on the Plugins page.
          </EmptyState>
        ) : (
          <div className={styles.stack}>
            <p className={styles.note}>
              Pick a type. Each type comes from an installed plugin; its settings form is the
              plugin&apos;s own.
            </p>
            <div className={styles.typeGrid} role="list" aria-label={`${noun} types`}>
              {installed.map((t) => (
                <div role="listitem" key={t.typeId}>
                  <button
                    type="button"
                    className={styles.typeOption}
                    style={{ width: '100%' }}
                    aria-disabled={t.available ? undefined : true}
                    onClick={() => {
                      if (t.available) choose(t);
                    }}
                  >
                    <span className={styles.iconTile}>
                      <Icon name={typeIcon(t.typeId, kind)} />
                    </span>
                    <span className={styles.typeText}>
                      <span className={styles.typeName}>{t.displayName}</span>
                      <span className={styles.typeMeta}>
                        {t.available ? describeType(t) : 'plugin unavailable'}
                      </span>
                      <span className={`${styles.typeMeta} mono`}>{t.plugin}</span>
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )
      ) : (
        <div className={styles.stack}>
          {type.description && <p className={styles.note}>{type.description}</p>}
          <Field
            label="Name"
            required
            help={`Shown on the Board and in every trace, e.g. "${type.displayName} — acme org".`}
            error={attempted && name.trim() === '' ? 'Required' : null}
          >
            {({ id, describedBy, invalid: bad }) => (
              <TextField
                id={id}
                aria-describedby={describedBy}
                invalid={bad}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            )}
          </Field>
          <SchemaForm
            schema={type.settingsSchema}
            value={settings}
            onChange={setSettings}
            showAllErrors={attempted}
            secretProviders={secretProviderIds(secretProviders.data)}
          />
          {caps !== null && renderCaps(type, caps, setCaps)}
          {attempted && invalid && (
            <Banner tone="error" title="Some fields need attention">
              Fix the highlighted fields, then create the {noun}.
            </Banner>
          )}
        </div>
      )}
    </Dialog>
  );
}
