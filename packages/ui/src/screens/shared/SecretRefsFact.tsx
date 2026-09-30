import type { SecretRefDTO } from '@ai-switchboard/core/contract';
import { parseSecretRef } from '@ai-switchboard/sdk/schema';

import { Icon } from '../../components/Icon.js';
import { Time } from '../../components/Time.js';
import { cx } from '../../lib/cx.js';
import styles from './detail.module.css';

export function SecretRefsFact({ refs }: { refs: SecretRefDTO[] }) {
  if (refs.length === 0) return null;
  return (
    <ul className={cx(styles.facts, styles.bareList)} aria-label="Secret references">
      {refs.map((r) => (
        <li key={r.field} className={styles.secret} title={`${r.field}: ${r.ref}`}>
          <Icon name="key" size={12} />
          <span className="mono">{parseSecretRef(r.ref)?.name ?? r.ref}</span>
          {r.ok ? (
            <span className={styles.secretOk}>
              verified <Time value={r.lastResolvedAt} fallback="not yet" />
            </span>
          ) : (
            <span className={styles.secretErr}>
              could not resolve{r.error ? ` · ${r.error}` : ''}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
