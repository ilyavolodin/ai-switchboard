import { useRef } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';

import { errorMessage } from '../api/client.js';
import { useLogout, useMe } from '../api/index.js';
import { Banner } from '../components/Banner.js';
import { Button } from '../components/Button.js';
import { Logo } from '../components/Logo.js';
import { Skeleton } from '../components/Skeleton.js';
import styles from './AppShell.module.css';
import { Rail } from './Rail.js';
import { SessionContext, sessionFromMe } from './session.js';
import { useGlobalShortcuts } from './shortcuts.js';
import { TopBar } from './TopBar.js';

export function AppShell() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();
  const searchRef = useRef<HTMLInputElement>(null);

  useGlobalShortcuts({
    onSearch: () => {
      searchRef.current?.focus();
    },
    onNavigate: (to) => {
      void navigate(to);
    },
  });

  if (me.isPending) {
    return (
      <div className={styles.center}>
        <Logo size={40} gapColor="var(--background)" />
        <Skeleton width={180} height={12} label="Loading AI Switchboard" />
      </div>
    );
  }

  if (me.isError) {
    return (
      <div className={styles.center}>
        <Logo size={40} gapColor="var(--background)" />
        <Banner
          tone="error"
          title="Cannot reach the Switchboard API"
          actions={
            <Button size="sm" variant="outline" onClick={() => void me.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(me.error)}
        </Banner>
      </div>
    );
  }

  if (!me.data.user) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }

  if (me.data.mustChangePassword) {
    return (
      <Navigate
        to="/change-password"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  const session = sessionFromMe(me.data);
  // Local accounts are first-class, so a missing issuer alone is no warning: only an evaluation
  // install (the Compose quick start) without OIDC shows the banner.
  const evaluation = session.evaluation && !session.oidcConfigured;

  return (
    <SessionContext.Provider value={session}>
      <div className={styles.shell}>
        <a href="#main" className={styles.skip}>
          Skip to content
        </a>
        <Rail
          onSignOut={() => {
            void logout.mutateAsync().then(() => navigate('/login'));
          }}
        />
        <div className={styles.main}>
          <TopBar searchRef={searchRef} />
          {evaluation && (
            <Banner
              tone="warn"
              className={styles.banner}
              title="OIDC is not configured — evaluation sign-in"
              actions={
                session.user?.role === 'admin' ? (
                  <Link to="/settings/sign-in" style={{ fontWeight: 500, fontSize: 12 }}>
                    Configure sign-in
                  </Link>
                ) : undefined
              }
            >
              This is an evaluation install that signs in with local passwords only. Set an OIDC
              issuer for single sign-on before real use.
            </Banner>
          )}
          <main id="main" className={styles.content} tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
