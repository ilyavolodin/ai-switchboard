import { Navigate, useLocation, useNavigate } from 'react-router';

import { useLogout, useMe } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { AuthPage } from '../shared/AuthPage.js';
import { safeReturnTo } from '../shared/safeReturnTo.js';
import styles from './ChangePassword.module.css';
import { ChangePasswordForm } from './ChangePasswordForm.js';

/**
 * Where a session signed in with a temporary password lands: every other API route refuses it until
 * the password changes.
 */
export function ChangePassword() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();
  const target = safeReturnTo(location.state, '/change-password');

  if (me.isPending) return <AuthPage title="Change password" loading />;
  const user = me.data?.user;
  if (!user) return <Navigate to="/login" replace state={{ from: '/change-password' }} />;
  const forced = me.data?.mustChangePassword ?? false;

  return (
    <AuthPage title={forced ? 'Choose a new password' : 'Change password'} logoSize={32}>
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
    </AuthPage>
  );
}
