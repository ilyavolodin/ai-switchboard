import { type SubmitEvent, useId, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { errorMessage, isApiRequestError } from '../../api/client.js';
import { OIDC_START_URL, useLogin, useMe } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { buttonClassName } from '../../components/buttonClass.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { TextField } from '../../components/TextField.js';
import { AuthPage } from '../shared/AuthPage.js';
import { safeReturnTo } from '../shared/safeReturnTo.js';
import { ForgotAccess } from './ForgotAccess.js';
import styles from './Login.module.css';

export function Login() {
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [forgotOpen, setForgotOpen] = useState(false);
  const forgotId = useId();
  const target = safeReturnTo(location.state, '/login');

  if (me.isPending) return <AuthPage title="AI Switchboard" loading />;
  if (me.data?.user) {
    return me.data.mustChangePassword ? (
      <Navigate to="/change-password" replace state={{ from: target }} />
    ) : (
      <Navigate to={target} replace />
    );
  }

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: (res) => {
          if (!res.user) return;
          if (res.mustChangePassword)
            void navigate('/change-password', { replace: true, state: { from: target } });
          else void navigate(target, { replace: true });
        },
      },
    );
  };

  const oidc = me.data?.oidcConfigured ?? false;
  const issuer = me.data?.oidcIssuer ?? null;
  const evaluation = me.data ? me.data.evaluation && !me.data.oidcConfigured : false;
  const failure = login.error
    ? isApiRequestError(login.error) && login.error.status === 401
      ? 'That email and password did not match.'
      : errorMessage(login.error)
    : null;

  return (
    <AuthPage title="AI Switchboard">
      <p className={styles.lede}>
        Sign in to see what feeds what, and change one connection safely.
      </p>
      {evaluation && (
        <Banner tone="warn" title="OIDC is not configured — evaluation sign-in">
          Use the local admin account from the deployment. Configure OIDC in Settings before real
          use.
        </Banner>
      )}
      {oidc && (
        <>
          <a className={buttonClassName('primary', 'lg', true)} href={OIDC_START_URL}>
            <Icon name="lock" size={14} />
            {issuer ? `Sign in with ${issuer}` : 'Sign in with single sign-on'}
          </a>
          <p className={styles.divider}>
            <span>or use a local password</span>
          </p>
        </>
      )}
      <form className={styles.form} onSubmit={submit}>
        <Field label="Email" required>
          {({ id }) => (
            <TextField
              id={id}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Password" required>
          {({ id }) => (
            <TextField
              id={id}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          )}
        </Field>
        {failure && <Banner tone="error">{failure}</Banner>}
        <Button
          type="submit"
          variant={oidc ? 'outline' : 'primary'}
          size="lg"
          block
          loading={login.isPending}
        >
          Sign in
        </Button>
      </form>
      <button
        type="button"
        className={styles.forgot}
        aria-expanded={forgotOpen}
        aria-controls={forgotId}
        onClick={() => {
          setForgotOpen((open) => !open);
        }}
      >
        Forgot password or email?
      </button>
      {forgotOpen && (
        <ForgotAccess id={forgotId} evaluationAdminEmail={me.data?.evaluationAdminEmail ?? null} />
      )}
    </AuthPage>
  );
}
