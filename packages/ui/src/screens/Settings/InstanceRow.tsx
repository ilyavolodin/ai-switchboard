import type { InstanceSummary } from '@ai-switchboard/core/contract';

import { errorMessage } from '../../api/client.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Toggle } from '../../components/Toggle.js';
import { InUseBanner, type InUseBannerProps } from '../shared/InUseBanner.js';
import type { InstanceRouteCopy } from './instancesModel.js';
import { ProviderDependents } from './ProviderDependents.js';
import { ProviderSecrets } from './ProviderSecrets.js';
import styles from './Settings.module.css';

export interface InstanceRowProps {
  instance: InstanceSummary;
  copy: InstanceRouteCopy;
  showingSecrets: boolean;
  /** Set when the last delete of this instance was refused. */
  deleteRefusal: { usedBy: InUseBannerProps['processes'] | null; error: unknown } | null;
  onDismissRefusal: () => void;
  onToggleSecrets: () => void;
  onEnable: (enabled: boolean) => void;
  onEdit: () => void;
  onReload: () => void;
  onTest: () => void;
  onDelete: () => void;
}

export function InstanceRow({
  instance: inst,
  copy,
  showingSecrets,
  deleteRefusal,
  onDismissRefusal,
  onToggleSecrets,
  onEnable,
  onEdit,
  onReload,
  onTest,
  onDelete,
}: InstanceRowProps) {
  return (
    <li className={styles.listItem} aria-label={inst.name}>
      <div className={styles.itemHead}>
        <span className={styles.itemName}>{inst.name}</span>
        <StatusChip size="sm" tone={inst.status.tone} label={inst.status.label} />
        <span className="t-caption">
          {copy.one} · {inst.typeName}
        </span>
        <span className={styles.grow} />
        <Toggle
          size="sm"
          label="Enabled"
          checked={inst.enabled}
          requires="admin"
          onChange={onEnable}
        />
      </div>
      {inst.instanceError && (
        <Banner tone="error" title="It could not start">
          {inst.instanceError}
        </Banner>
      )}
      {inst.health?.message && <span className="t-caption">{inst.health.message}</span>}
      {copy.hasSecrets && inst.dependents && (
        <ProviderDependents provider={inst.name} dependents={inst.dependents} />
      )}
      {deleteRefusal?.usedBy ? (
        <InUseBanner
          name={inst.name}
          kind={copy.one}
          processes={deleteRefusal.usedBy}
          onDismiss={onDismissRefusal}
        />
      ) : (
        deleteRefusal && (
          <Banner tone="error" title={`${inst.name} was not deleted`}>
            {errorMessage(deleteRefusal.error)}
          </Banner>
        )
      )}
      {Object.keys(inst.settings).length > 0 && (
        <KeyValueList data={inst.settings} label={`${inst.name} settings`} />
      )}
      {copy.hasSecrets && showingSecrets && <ProviderSecrets instance={inst} />}
      <div className={styles.rowActions}>
        {copy.hasSecrets && (
          <Button
            size="sm"
            variant="ghost"
            icon="key"
            requires="admin"
            aria-expanded={showingSecrets}
            aria-label={`${showingSecrets ? 'Hide' : 'Show'} secrets in ${inst.name}`}
            onClick={onToggleSecrets}
          >
            Secrets
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon="edit"
          requires="admin"
          aria-label={`Edit ${inst.name}`}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          requires="admin"
          aria-label={`Reload ${inst.name}`}
          onClick={onReload}
        >
          Reload
        </Button>
        {copy.canTest && (
          <Button
            size="sm"
            variant="ghost"
            icon="play"
            requires="admin"
            aria-label={`Send a test notification to ${inst.name}`}
            onClick={onTest}
          >
            Test
          </Button>
        )}
        <Button
          size="sm"
          variant="danger-outline"
          icon="trash"
          requires="admin"
          aria-label={`Delete ${inst.name}`}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </li>
  );
}
