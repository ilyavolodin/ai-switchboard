import type { InspectPluginRequest, InspectPluginResponse } from '@ai-switchboard/core/contract';
import type { UseMutationResult } from '@tanstack/react-query';
import { useState } from 'react';

import { errorMessage } from '../../api/client.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { TextField } from '../../components/TextField.js';
import styles from '../Sources/forms.module.css';
import { ManifestReview } from './ManifestReview.js';
import { isPackageName, parsePackageSpec } from './pluginModel.js';

export interface AddPluginDialogProps {
  open: boolean;
  onClose: () => void;
  initialSpec: string;
  /** Owned by the page so the catalogue can start it on open. */
  inspect: UseMutationResult<InspectPluginResponse, Error, InspectPluginRequest>;
  onConfirm: (request: InspectPluginRequest, manifest: InspectPluginResponse) => Promise<boolean>;
}

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

        {manifest && <ManifestReview manifest={manifest} />}

        <Banner tone="info" icon="info">
          Plugins run in the core&apos;s process as trusted code. Adding one installs and loads it
          now, and every replica installs it within a minute. Removing one unloads it everywhere
          within a minute; upgrading a loaded plugin applies on the next restart.
        </Banner>
      </div>
    </Dialog>
  );
}
