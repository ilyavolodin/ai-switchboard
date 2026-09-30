import { CopyButton } from '../../components/CopyButton.js';
import { Icon, type IconName } from '../../components/Icon.js';
import styles from './detail.module.css';

/** A URL a person gives another system (webhook, callback), with a copy button. */
export function UrlFact({ icon, label, url }: { icon: IconName; label: string; url: string }) {
  return (
    <span className={styles.fact}>
      <Icon name={icon} size={13} />
      {label}
      <span className={`${styles.url} mono`} title={url}>
        {url}
      </span>
      <CopyButton value={url} label={`Copy ${label} URL`} />
    </span>
  );
}
