import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { Toggle } from '../../components/Toggle.js';
import { TypeIcon } from '../../components/TypeIcon.js';
import styles from './instanceCard.module.css';

/** Icon, linked name, a meta line and the enable toggle at the top of a source or destination card. */
export function InstanceCardHeader({
  kind,
  name,
  icon,
  href,
  meta,
  enabled,
  onEnabledChange,
}: {
  kind: 'source' | 'destination';
  name: string;
  icon: string | null | undefined;
  href: string;
  meta: ReactNode;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
}) {
  return (
    <div className={styles.head}>
      <span className={styles.iconTile}>
        <TypeIcon icon={icon} kind={kind} />
      </span>
      <span className={styles.titles}>
        <Link to={href} className={styles.name}>
          {name}
        </Link>
        <span className={styles.meta}>{meta}</span>
      </span>
      <span className={styles.above}>
        <Toggle
          size="sm"
          ariaLabel={`${name} enabled`}
          value={enabled}
          requires="operator"
          onChange={onEnabledChange}
        />
      </span>
    </div>
  );
}
