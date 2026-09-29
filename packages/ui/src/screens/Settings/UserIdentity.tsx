import styles from './Settings.module.css';
import { initials } from './settingsForm.js';

export function UserIdentity({ email, you }: { email: string; you: boolean }) {
  return (
    <span className={styles.who}>
      <span className={styles.avatar} aria-hidden="true">
        {initials(email)}
      </span>
      {email}
      {you && <span className={styles.muted}>· you</span>}
    </span>
  );
}
