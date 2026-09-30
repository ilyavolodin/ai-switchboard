import { Link } from 'react-router';

import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Logo } from '../../components/Logo.js';
import styles from './NoAccess.module.css';

export function NoAccess() {
  return (
    <div className={styles.page}>
      <Card className={styles.card} padding="roomy">
        <EmptyState
          title="You're signed in, but you don't have access yet"
          actions={<Link to="/login">Try a different account</Link>}
        >
          <div className={styles.logo}>
            <Logo size={36} gapColor="var(--card)" label={null} />
          </div>
          Your email is not on this Switchboard's list of users or allowed domains. Ask an admin to
          add you in Settings › Users.
        </EmptyState>
      </Card>
    </div>
  );
}
