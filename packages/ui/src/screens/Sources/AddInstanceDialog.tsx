import type { PluginSearchResult, PluginTypeDTO } from '@ai-switchboard/core/contract';
import { type ReactNode, useState } from 'react';

import { errorMessage } from '../../api/client.js';
import { useInspectPlugin, useInstallPlugin, useSecretProviders } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Field } from '../../components/Field.js';
import { TypeIcon } from '../../components/TypeIcon.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { Skeleton } from '../../components/Skeleton.js';
import { TextField } from '../../components/TextField.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { asRecord, secretProviderIds } from '../../lib/instances.js';
import { deliverySample, EMPTY_SAMPLE, type SampleDraft } from '../../lib/sampleDelivery.js';
import { schemaDefaults, validateAgainstSchema } from '../../lib/schema.js';
import { ManifestReview } from '../Plugins/ManifestReview.js';
import { NpmSearch } from '../Plugins/NpmSearch.js';
import styles from './forms.module.css';
import { SamplePreview } from './SamplePreview.js';

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
  kind: 'source' | 'destination';
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
 * "Add source" / "Add destination": pick an installed type — or find one on npm, review what it
 * asks for and install it (admins), which continues straight into its form — then name the
 * instance and fill the plugin's settings form (rendered from its `settingsSchema`, secrets as
 * `secret://` references) plus the core's caps. The form is kept while the reason prompt is
 * open, so cancelling it returns here with nothing lost.
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
  // Installing from npm: the package under review, the types it brought, and a note.
  const [review, setReview] = useState<PluginSearchResult | null>(null);
  const [awaiting, setAwaiting] = useState<string[] | null>(null);
  const [installNote, setInstallNote] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  // The pasted sample delivery (push sources): feeds the preview panel and path suggestions.
  const [sample, setSample] = useState<SampleDraft>(EMPTY_SAMPLE);
  const inspect = useInspectPlugin();
  const install = useReasonedMutation(
    useInstallPlugin(),
    (v: { package: string; range?: string }) => ({
      title: `Install ${v.package}${v.range ? `@${v.range}` : ''}?`,
      consequence: `The package is installed, pinned in plugins.lock.json and loaded now; every replica installs it within a minute. You continue with its ${kind} form.`,
      confirmLabel: 'Install plugin',
    }),
    {
      successMessage: (added) =>
        added.pendingRestart ? 'Installed · restart to apply' : 'Installed · ready to use',
    },
  );

  const choose = (t: PluginTypeDTO) => {
    setType(t);
    setName(t.displayName);
    setSettings(asRecord(schemaDefaults(t.settingsSchema)));
    setCaps(initialCaps(t));
    setAttempted(false);
    setSample(EMPTY_SAMPLE);
  };
  // Once the installed plugin's types arrive in the picker, continue into the first one
  // (adjusting state while rendering, as React recommends over an effect).
  const arrived = awaiting && types?.find((t) => t.available && awaiting.includes(t.typeId));
  if (arrived) {
    setAwaiting(null);
    choose(arrived);
  }

  const startReview = (r: PluginSearchResult) => {
    setInstallNote(null);
    setReview(r);
    inspect.reset();
    inspect.mutate({ package: r.package, range: `^${r.version}` });
  };
  const manifest =
    review && inspect.data && inspect.variables.package === review.package ? inspect.data : null;
  const runInstall = async () => {
    if (!review || !manifest) return;
    setHidden(true);
    const added = await install.run({ package: review.package, range: `^${review.version}` });
    setHidden(false);
    if (!added) return;
    setReview(null);
    const ids = added.types.filter((t) => t.kind === kind).map((t) => t.typeId);
    if (added.pendingRestart) {
      setInstallNote(`${added.name} is installed; restart Switchboard to load this version.`);
    } else if (ids.length === 0) {
      setInstallNote(
        `${added.name} is installed but contributes no ${kind} type${added.statusMessage ? `: ${added.statusMessage}` : '.'}`,
      );
    } else {
      setAwaiting(ids);
    }
  };

  const reset = () => {
    setType(null);
    setName('');
    setSettings({});
    setCaps(null);
    setAttempted(false);
  };

  const errors = type ? validateAgainstSchema(type.settingsSchema, settings) : {};
  const pushSource = kind === 'source' && type !== null && type.mode !== 'pull';
  const invalid = Object.keys(errors).length > 0 || name.trim() === '';
  const noun = kind === 'source' ? 'source' : 'destination';

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
      open={open && !hidden}
      onClose={onClose}
      size="wide"
      dismissible={false}
      title={
        type
          ? `New ${type.displayName} ${noun}`
          : review
            ? `Install ${review.package}`
            : `Add a ${noun}`
      }
      footer={
        <div className={styles.footer}>
          {!type && review && (
            <Button
              variant="ghost"
              icon="back"
              onClick={() => {
                setReview(null);
              }}
            >
              Back to types
            </Button>
          )}
          {type && (
            <Button variant="ghost" icon="back" onClick={reset}>
              Choose another type
            </Button>
          )}
          <span className={styles.spacer} />
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {!type && review && (
            <Button
              variant="primary"
              requires="admin"
              loading={install.pending}
              disabled={!manifest?.compatible}
              disabledReason={
                manifest && !manifest.compatible
                  ? 'This version does not support the running SDK'
                  : 'Reading the package manifest'
              }
              onClick={() => void runInstall()}
            >
              Install and continue
            </Button>
          )}
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
      {!type && review ? (
        <div className={styles.stack}>
          <p className={styles.note}>
            {review.description || review.package} Read what it asks for before installing.
          </p>
          {inspect.isPending && <Skeleton lines={3} height={32} label="Reading the manifest" />}
          {inspect.isError && (
            <Banner tone="error" title="The package could not be inspected">
              {errorMessage(inspect.error)}
            </Banner>
          )}
          {manifest && <ManifestReview manifest={manifest} />}
          <Banner tone="info" icon="info">
            Plugins run in the core&apos;s process as trusted code. Installing one needs the admin
            role and a reason, and is recorded in the audit log.
          </Banner>
        </div>
      ) : !type ? (
        <div className={styles.stack}>
          {installNote && (
            <Banner tone="warn" title="Not ready yet">
              {installNote}
            </Banner>
          )}
          {awaiting && <Skeleton lines={1} height={32} label="Loading the new type" />}
          {loading ? (
            <Skeleton lines={3} height={48} label={`Loading ${noun} types`} />
          ) : installed.length === 0 ? (
            <EmptyState title={`No ${noun} types are installed`} compact>
              {kind === 'source' ? 'Source' : 'Destination'} types come from plugins. Find one on
              npm below, or an admin can add any package on the Plugins page.
            </EmptyState>
          ) : (
            <>
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
                        <TypeIcon icon={t.icon} kind={kind} />
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
            </>
          )}
          <section className={styles.stack} aria-label="Find more on npm">
            <span className={styles.legend}>Find more on npm</span>
            <NpmSearch kind={kind} compact onInstall={startReview} />
          </section>
        </div>
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
            sample={pushSource ? deliverySample(sample) : null}
          />
          {pushSource && (
            <SamplePreview
              typeId={type.typeId}
              settings={settings}
              sample={sample}
              onSampleChange={setSample}
            />
          )}
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
