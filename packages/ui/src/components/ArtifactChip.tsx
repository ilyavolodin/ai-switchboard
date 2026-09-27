import type { ArtifactRef } from '@ai-switchboard/core/contract';
import { Link } from 'react-router';

import { artifactLabel, artifactSystem } from '../lib/artifact.js';
import styles from './ArtifactChip.module.css';
import { Icon, type IconName } from './Icon.js';

export interface ArtifactChipProps {
  artifact: ArtifactRef;
  /** Link to an in-app route (e.g. the trace) instead of the external URL. */
  to?: string;
  showIcon?: boolean;
}

/** The icon for an artifact kind (`github.pr`, `linear.issue`, `datadog.monitor`, ...). */
function kindIcon(kind: string): IconName {
  if (kind.includes('pr') || kind.includes('pull')) return 'pr';
  if (kind.includes('issue')) return 'issue';
  if (kind.includes('monitor') || kind.includes('alert')) return 'alert';
  if (kind.includes('run')) return 'run';
  return 'artifact';
}

/** A mono artifact id with its kind icon; links out in a new tab (or in-app with `to`). */
export function ArtifactChip({ artifact, to, showIcon = true }: ArtifactChipProps) {
  const label = artifactLabel(artifact);
  const content = (
    <>
      {showIcon && <Icon name={kindIcon(artifact.kind)} size={12} className={styles.icon} />}
      <span className={styles.id}>{label}</span>
    </>
  );
  if (to) {
    return (
      <Link to={to} className={styles.chip} title={`Trace ${label}`}>
        {content}
      </Link>
    );
  }
  if (artifact.url) {
    return (
      <a
        href={artifact.url}
        target="_blank"
        rel="noreferrer"
        className={styles.chip}
        title={`Open in ${artifactSystem(artifact.kind)}`}
        aria-label={`${label} (opens ${artifactSystem(artifact.kind)} in a new tab)`}
      >
        {content}
        <Icon name="external" size={11} className={styles.external} />
      </a>
    );
  }
  return <span className={styles.chip}>{content}</span>;
}
