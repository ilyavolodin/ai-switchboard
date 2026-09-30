import type { SecretProviderDependentDTO } from '@ai-switchboard/core/contract';
import { Link } from 'react-router';

import { StatusChip } from '../../components/StatusChip.js';
import { INSTANCE_KIND_LABEL, instanceHref } from '../../lib/instanceNames.js';
import styles from './Settings.module.css';

/**
 * The provider's create, enable, edit and reload rebuild these instances, so their status is the
 * outcome of the last change.
 */
export function ProviderDependents({
  provider,
  dependents,
}: {
  provider: string;
  dependents: SecretProviderDependentDTO[];
}) {
  if (dependents.length === 0) {
    return (
      <span className="t-caption">
        No source, destination or notifier references {provider} yet.
      </span>
    );
  }
  return (
    <section aria-label={`Instances using ${provider}`} className={styles.dependents}>
      <span className="t-overline">
        used by {dependents.length} instance{dependents.length === 1 ? '' : 's'}
      </span>
      <ul className={styles.dependentList}>
        {dependents.map((d) => (
          <li key={`${d.kind}:${d.id}`} className={styles.dependent}>
            <StatusChip size="sm" tone={d.status.tone} label={d.status.label} />
            <span className="t-caption">{INSTANCE_KIND_LABEL[d.kind]}</span>
            <Link to={instanceHref(d.kind, d.id)}>{d.name}</Link>
            {d.instanceError && (
              <span className={`t-caption ${styles.muted}`}>{d.instanceError}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
