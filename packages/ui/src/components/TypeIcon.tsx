import { ICON_DATA_URI_PREFIX, iconProblem, isIconName } from '@ai-switchboard/sdk/icons';

import { Icon } from './Icon.js';
import styles from './TypeIcon.module.css';

/** The instance kinds a type icon can stand for. */
export type TypeIconKind = 'source' | 'destination' | 'notifier' | 'secret_provider';

const GENERIC = {
  source: 'sources',
  destination: 'destinations',
  notifier: 'info',
  secret_provider: 'key',
} as const;

export interface TypeIconProps {
  /** The type's declared icon (`typeIcon` / `PluginTypeDTO.icon`), if any. */
  icon: string | null | undefined;
  kind: TypeIconKind;
  size?: number;
}

/**
 * A plugin type's icon: a built-in icon by name, or the plugin's SVG data URI drawn through
 * `<img>` (never inline markup, so an SVG cannot run script). Anything else, or nothing, falls
 * back to the kind's generic icon.
 */
export function TypeIcon({ icon, kind, size = 16 }: TypeIconProps) {
  if (isIconName(icon)) return <Icon name={icon} size={size} />;
  if (typeof icon === 'string' && icon.startsWith(ICON_DATA_URI_PREFIX) && !iconProblem(icon)) {
    return (
      <img className={styles.img} src={icon} alt="" width={size} height={size} draggable={false} />
    );
  }
  return <Icon name={GENERIC[kind]} size={size} />;
}
