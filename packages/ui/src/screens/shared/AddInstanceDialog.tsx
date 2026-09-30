import type { JSONSchema, PluginSearchResult, PluginTypeDTO } from '@ai-switchboard/core/contract';
import { type ReactNode, useState } from 'react';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { useSchemaErrors } from '../../hooks/useSchemaErrors.js';
import { deliverySample, EMPTY_SAMPLE, type SampleDraft } from '../../lib/sampleDelivery.js';
import { schemaDefaults } from '../../lib/schema.js';
import { asRecord } from '../../lib/values.js';
import styles from './forms.module.css';
import { InstanceConfigureStep } from './InstanceConfigureStep.js';
import { installOutcome } from './pluginModel.js';
import { PluginReviewStep } from './PluginReviewStep.js';
import { TypePicker } from './TypePicker.js';
import { useHiddenWhile } from './useHiddenWhile.js';
import { usePluginInstall } from './usePluginInstall.js';

export interface InstanceDraft<C> {
  type: PluginTypeDTO;
  name: string;
  settings: Record<string, unknown>;
  caps: C;
}

export interface SampleSlot {
  type: PluginTypeDTO;
  settings: Record<string, unknown>;
  sample: SampleDraft;
  onSampleChange: (next: SampleDraft) => void;
}

export interface AddInstanceDialogProps<C> {
  open: boolean;
  onClose: () => void;
  kind: 'source' | 'destination';
  types: PluginTypeDTO[] | undefined;
  loading?: boolean;
  initialCaps: (type: PluginTypeDTO) => C;
  renderCaps: (type: PluginTypeDTO, caps: C, onChange: (next: C) => void) => ReactNode;
  describeType: (type: PluginTypeDTO) => string;
  /** Resolves true when created; the dialog is hidden while it runs (it asks for a reason). */
  onSubmit: (draft: InstanceDraft<C>) => Promise<boolean>;
  /** A sample delivery that feeds the settings' path suggestions, for the types it applies to. */
  sample?: { applies: (type: PluginTypeDTO) => boolean; render: (slot: SampleSlot) => ReactNode };
}

interface Configuring<C> {
  type: PluginTypeDTO;
  name: string;
  settings: Record<string, unknown>;
  caps: C;
  sample: SampleDraft;
  attempted: boolean;
}

const NO_SCHEMA: JSONSchema = {};

function startConfiguring<C>(type: PluginTypeDTO, caps: C): Configuring<C> {
  return {
    type,
    name: type.displayName,
    settings: asRecord(schemaDefaults(type.settingsSchema)),
    caps,
    sample: EMPTY_SAMPLE,
    attempted: false,
  };
}

/** The form is kept while the reason prompt is open, so cancelling it returns here intact. */
export function AddInstanceDialog<C>({
  open,
  onClose,
  kind,
  types,
  loading = false,
  initialCaps,
  renderCaps,
  describeType,
  onSubmit,
  sample,
}: AddInstanceDialogProps<C>) {
  const [config, setConfig] = useState<Configuring<C> | null>(null);
  const [review, setReview] = useState<PluginSearchResult | null>(null);
  const [awaiting, setAwaiting] = useState<string[] | null>(null);
  const [installNote, setInstallNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const behind = useHiddenWhile();
  const { inspect, install } = usePluginInstall('Install', `You continue with its ${kind} form.`);

  const choose = (t: PluginTypeDTO) => {
    setConfig(startConfiguring(t, initialCaps(t)));
  };
  const arrived = awaiting && types?.find((t) => t.available && awaiting.includes(t.typeId));
  if (arrived) {
    setAwaiting(null);
    choose(arrived);
  }

  const edit = (patch: Partial<Configuring<C>>) => {
    setConfig((c) => (c ? { ...c, ...patch } : c));
  };

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
    const request = { package: review.package, range: `^${review.version}` };
    const added = await behind.run(() => install.run(request));
    if (!added) return;
    setReview(null);
    const outcome = installOutcome(added, kind);
    if (outcome.kind === 'note') setInstallNote(outcome.note);
    else setAwaiting(outcome.typeIds);
  };

  const errors = useSchemaErrors(config?.type.settingsSchema ?? NO_SCHEMA, config?.settings ?? {});
  const invalid = Object.keys(errors).length > 0 || (config?.name.trim() ?? '') === '';
  const withSample = config != null && sample?.applies(config.type) === true;

  const submit = async () => {
    if (!config) return;
    if (invalid) {
      edit({ attempted: true });
      return;
    }
    setBusy(true);
    const ok = await behind.run(() =>
      onSubmit({
        type: config.type,
        name: config.name.trim(),
        settings: config.settings,
        caps: config.caps,
      }),
    );
    setBusy(false);
    if (ok) setConfig(null);
  };

  const step = config ? 'configure' : review ? 'review' : 'pick';
  const title =
    step === 'configure' && config
      ? `New ${config.type.displayName} ${kind}`
      : step === 'review' && review
        ? `Install ${review.package}`
        : `Add a ${kind}`;

  return (
    <Dialog
      open={open && !behind.hidden}
      onClose={onClose}
      size="wide"
      dismissible={false}
      title={title}
      footer={
        <div className={styles.footer}>
          {step === 'review' && (
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
          {step === 'configure' && (
            <Button
              variant="ghost"
              icon="back"
              onClick={() => {
                setConfig(null);
              }}
            >
              Choose another type
            </Button>
          )}
          <span className={styles.spacer} />
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {step === 'review' && (
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
          {step === 'configure' && (
            <Button
              variant="primary"
              requires="operator"
              loading={busy}
              onClick={() => void submit()}
            >
              Create {kind}
            </Button>
          )}
        </div>
      }
    >
      {config ? (
        <InstanceConfigureStep
          type={config.type}
          noun={kind}
          name={config.name}
          onNameChange={(name) => {
            edit({ name });
          }}
          settings={config.settings}
          onSettingsChange={(settings) => {
            edit({ settings });
          }}
          attempted={config.attempted}
          invalid={invalid}
          errors={errors}
          sample={withSample ? deliverySample(config.sample) : null}
          afterSettings={
            withSample
              ? sample.render({
                  type: config.type,
                  settings: config.settings,
                  sample: config.sample,
                  onSampleChange: (next) => {
                    edit({ sample: next });
                  },
                })
              : null
          }
          caps={renderCaps(config.type, config.caps, (caps) => {
            edit({ caps });
          })}
        />
      ) : review ? (
        <PluginReviewStep review={review} inspect={inspect} manifest={manifest} />
      ) : (
        <TypePicker
          kind={kind}
          types={types ?? []}
          loading={loading}
          awaiting={awaiting != null}
          installNote={installNote}
          describeType={describeType}
          onChoose={choose}
          onReview={startReview}
        />
      )}
    </Dialog>
  );
}
