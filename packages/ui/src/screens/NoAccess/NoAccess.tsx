import { Link } from 'react-router';

import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Logo } from '../../components/Logo.js';

export function NoAccess() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--background)',
      }}
    >
      <Card style={{ width: 440, maxWidth: '100%' }} padding="roomy">
        <EmptyState
          title="You're signed in, but you don't have access yet"
          actions={<Link to="/login">Try a different account</Link>}
        >
          <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 8 }}>
            <Logo size={36} gapColor="var(--card)" label={null} />
          </div>
          Your email is not on this Switchboard's list of users or allowed domains. Ask an admin to
          add you in Settings › Users.
        </EmptyState>
      </Card>
    </div>
  );
}
