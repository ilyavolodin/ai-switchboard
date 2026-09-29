import { ICON_DATA_URI_PREFIX, iconProblem, isIconName } from '@ai-switchboard/sdk/icons';

import { Icon } from './Icon.js';
import styles from './TypeIcon.module.css';

export type TypeIconKind = 'source' | 'destination' | 'notifier' | 'secret_provider';

const GENERIC = {
  source: 'sources',
  destination: 'destinations',
  notifier: 'info',
  secret_provider: 'key',
} as const;

export interface TypeIconProps {
  icon: string | null | undefined;
  kind: TypeIconKind;
  size?: number;
}

/** A plugin's SVG data URI is drawn through `<img>`, never inline, so it cannot run script. */
export function TypeIcon({ icon, kind, size = 16 }: TypeIconProps) {
  if (isIconName(icon)) return <Icon name={icon} size={size} />;
  if (typeof icon === 'string' && icon.startsWith(ICON_DATA_URI_PREFIX) && !iconProblem(icon)) {
    return (
      <img className={styles.img} src={icon} alt="" width={size} height={size} draggable={false} />
    );
  }
  return <Icon name={GENERIC[kind]} size={size} />;
}
