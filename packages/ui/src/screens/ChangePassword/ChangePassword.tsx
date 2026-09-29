import { Navigate, useLocation, useNavigate } from 'react-router';

import { useLogout, useMe } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Logo } from '../../components/Logo.js';
import { Skeleton } from '../../components/Skeleton.js';
import styles from './ChangePassword.module.css';
import { ChangePasswordForm } from './ChangePasswordForm.js';

function fromState(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('/change-password')
    ? from
    : '/';
}

/**
 * Where a session signed in with a temporary password lands: every other API route refuses it until
 * the password changes.
 */
export function ChangePassword() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();
  const target = fromState(location.state);

  if (me.isPending) {
    return (
      <div className={styles.page}>
        <Skeleton width={200} height={12} />
      </div>
    );
  }
  const user = me.data?.user;
  if (!user) return <Navigate to="/login" replace state={{ from: '/change-password' }} />;
  const forced = me.data?.mustChangePassword ?? false;

  return (
    <div className={styles.page}>
      <main className={styles.panel}>
        <div className={styles.brand}>
          <Logo size={32} gapColor="var(--card)" label={null} />
          <h1 className={styles.name}>{forced ? 'Choose a new password' : 'Change password'}</h1>
        </div>
        {forced ? (
          <Banner tone="warn" title="Your password is temporary">
            An admin set the password for {user.email}. Choose your own to continue.
          </Banner>
        ) : !user.hasPassword ? (
          <Banner tone="info" title="This account signs in through OIDC">
            It has no local password. Ask an admin to set one if you need it.
          </Banner>
        ) : (
          <p className={styles.lede}>
            Signed in as {user.email}. Your other sessions end when the password changes.
          </p>
        )}
        {(forced || user.hasPassword) && (
          <ChangePasswordForm
            email={user.email}
            submitLabel={forced ? 'Save and continue' : 'Change password'}
            onChanged={() => {
              void navigate(target, { replace: true });
            }}
          />
        )}
        {forced ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void logout.mutateAsync().then(() => navigate('/login', { replace: true }));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigate(target);
            }}
          >
            Back
          </Button>
        )}
      </main>
    </div>
  );
}
