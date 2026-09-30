import type { ReactNode } from 'react';

import { Logo } from '../../components/Logo.js';
import { Skeleton } from '../../components/Skeleton.js';
import styles from './AuthPage.module.css';

/** The centred card of the pages outside the app shell (sign in, change password). */
export function AuthPage({
  title,
  logoSize = 40,
  loading = false,
  children,
}: {
  title: string;
  logoSize?: number;
  /** While the session is still loading: a placeholder instead of the card. */
  loading?: boolean;
  children?: ReactNode;
}) {
  if (loading) {
    return (
      <div className={styles.page}>
        <Skeleton width={200} height={12} />
      </div>
    );
  }
  return (
    <div className={styles.page}>
      <main className={styles.panel}>
        <div className={styles.brand}>
          <Logo size={logoSize} gapColor="var(--card)" label={null} />
          <h1 className={styles.name}>{title}</h1>
        </div>
        {children}
      </main>
    </div>
  );
}
