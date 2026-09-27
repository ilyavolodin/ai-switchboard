import type { InspectPluginRequest, InspectPluginResponse } from '@ai-switchboard/core/contract';
import type { UseMutationResult } from '@tanstack/react-query';
import { useState } from 'react';

import { errorMessage } from '../../api/client.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { StatusChip } from '../../components/StatusChip.js';
import { TextField } from '../../components/TextField.js';
import styles from '../Sources/forms.module.css';
import {
  isPackageName,
  kindLabel,
  networkText,
  parsePackageSpec,
  secretsText,
} from './pluginModel.js';

export interface AddPluginDialogProps {
  open: boolean;
  onClose: () => void;
  /** Prefilled "package@range" (from the catalogue). */
  initialSpec: string;
  /** `POST /plugins/inspect`, owned by the page so the catalogue can start it on open. */
  inspect: UseMutationResult<InspectPluginResponse, Error, InspectPluginRequest>;
  /** Installs (asks for a reason); resolves true when it was added. */
  onConfirm: (request: InspectPluginRequest, manifest: InspectPluginResponse) => Promise<boolean>;
}

/**
 * "Add plugin": a package name and version range, then the manifest the core read from npm —
 * resolved version, SDK compatibility, contributed types and the declared network and secret
 * capabilities — shown before anything is installed. Adding writes the lockfile; a restart
 * applies it.
 */
export function AddPluginDialog({
  open,
  onClose,
  initialSpec,
  inspect,
  onConfirm,
}: AddPluginDialogProps) {
  const [spec, setSpec] = useState(initialSpec);
  const [busy, setBusy] = useState(false);
  const request = parsePackageSpec(spec);
  const validName = isPackageName(request.package);
  const manifest =
    inspect.data &&
    inspect.variables.package === request.package &&
    inspect.variables.range === request.range
      ? inspect.data
      : null;

  const runInspect = () => {
    if (validName) inspect.mutate(request);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="wide"
      title="Add plugin"
      footer={
        <div className={styles.footer}>
          <span className={styles.spacer} />
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            requires="admin"
            loading={busy}
            disabled={!manifest?.compatible}
            disabledReason={
              manifest && !manifest.compatible
                ? 'This version does not support the running SDK'
                : 'Inspect the package first to see what it asks for'
            }
            onClick={() => {
              if (!manifest) return;
              setBusy(true);
              void onConfirm(request, manifest).finally(() => {
                setBusy(false);
              });
            }}
          >
            Add plugin
          </Button>
        </div>
      }
    >
      <div className={styles.stack}>
        <form
          className={styles.footer}
          style={{ alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            runInspect();
          }}
        >
          <Field
            label="Package and version range"
            help="An npm package, optionally with a range: @acme/switchboard-source-jira@^1"
            error={spec.trim() && !validName ? 'Not a package name' : null}
            className={styles.spacer}
          >
            {({ id, describedBy, invalid }) => (
              <TextField
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                mono
                autoComplete="off"
                spellCheck={false}
                placeholder="@scope/package@^1"
                value={spec}
                onChange={(e) => {
                  setSpec(e.target.value);
                }}
              />
            )}
          </Field>
          <Button
            type="submit"
            variant="outline"
            requires="admin"
            loading={inspect.isPending}
            disabled={!validName}
            disabledReason="Type a package name"
          >
            Inspect
          </Button>
        </form>

        {inspect.isError && inspect.variables.package === request.package && (
          <Banner tone="error" title="The package could not be inspected">
            {errorMessage(inspect.error)}
          </Banner>
        )}

        {manifest && (
          <section className={styles.caps} aria-label="Manifest">
            <div className={styles.footer}>
              <span className={styles.legend}>
                Manifest · resolved <span className="mono">{manifest.version}</span>
              </span>
              <span className={styles.spacer} />
              {manifest.compatible ? (
                <StatusChip tone="ok" size="sm" label={`sdk ${manifest.sdkRange} ok`} />
              ) : (
                <StatusChip
                  tone="error"
                  size="sm"
                  label={`incompatible · sdk ${manifest.sdkRange}`}
                />
              )}
            </div>
            <KeyValueList
              label="Manifest capabilities"
              data={[
                [
                  'contributes',
                  manifest.types.length
                    ? manifest.types.map((t) => `${t.displayName} ${kindLabel(t.kind)}`).join(', ')
                    : 'nothing',
                ],
                ['network', <span className="mono">{networkText(manifest.capabilities)}</span>],
                ['secrets', <span className="mono">{secretsText(manifest.capabilities)}</span>],
                [
                  'integrity',
                  <span className="mono">
                    {manifest.integrity ?? 'unknown'} · pinned in plugins.lock.json
                  </span>,
                ],
              ]}
            />
          </section>
        )}

        <Banner tone="info" icon="info">
          Plugins run in the core&apos;s process as trusted code. Adding one writes the lockfile
          now; a restart applies it, one replica at a time, so no runs are lost.
        </Banner>
      </div>
    </Dialog>
  );
}
