import type { InspectPluginRequest, InspectPluginResponse } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { TextField } from '../../components/TextField.js';
import styles from '../shared/forms.module.css';
import { ManifestReview } from '../shared/ManifestReview.js';
import { PluginTrustNote } from '../shared/PluginTrustNote.js';
import { isPackageName, parsePackageSpec } from '../shared/pluginModel.js';
import { useHiddenWhile } from '../shared/useHiddenWhile.js';
import type { usePluginInstall } from '../shared/usePluginInstall.js';

export interface AddPluginDialogProps {
  open: boolean;
  onClose: () => void;
  initialSpec: string;
  /** Owned by the page so a search result can start inspecting on open. */
  install: ReturnType<typeof usePluginInstall>;
  onConfirm: (request: InspectPluginRequest, manifest: InspectPluginResponse) => Promise<boolean>;
}

export function AddPluginDialog({
  open,
  onClose,
  initialSpec,
  install,
  onConfirm,
}: AddPluginDialogProps) {
  const { inspect, manifestFor, inspectErrorFor } = install;
  const [spec, setSpec] = useState(initialSpec);
  const behind = useHiddenWhile();
  const request = parsePackageSpec(spec);
  const validName = isPackageName(request.package);
  const manifest = manifestFor(request);

  const runInspect = () => {
    if (validName) inspect.mutate(request);
  };

  return (
    <Dialog
      open={open && !behind.hidden}
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
            loading={behind.hidden}
            disabled={!manifest?.compatible}
            disabledReason={
              manifest && !manifest.compatible
                ? 'This version does not support the running SDK'
                : 'Inspect the package first to see what it asks for'
            }
            onClick={() => {
              if (manifest) void behind.run(() => onConfirm(request, manifest));
            }}
          >
            Add plugin
          </Button>
        </div>
      }
    >
      <div className={styles.stack}>
        <form
          className={`${styles.footer} ${styles.alignEnd}`}
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

        {manifest && <ManifestReview manifest={manifest} />}

        <PluginTrustNote inspectError={inspectErrorFor(request.package)}>
          Adding one installs and loads it now, and every replica installs it within a minute.
          Removing one unloads it everywhere within a minute; upgrading a loaded plugin applies on
          the next restart.
        </PluginTrustNote>
      </div>
    </Dialog>
  );
}
