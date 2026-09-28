import { Link, NavLink, useNavigate } from 'react-router';

import { usePlugins, useProcesses, useStatus } from '../api/index.js';
import { useAbout } from '../api/hooks/settings.js';
import { Icon } from '../components/Icon.js';
import { IconButton } from '../components/IconButton.js';
import { Logo } from '../components/Logo.js';
import { cx } from '../lib/cx.js';
import { NAV_ITEMS } from './nav.js';
import styles from './Rail.module.css';
import { roleLabel, useSession } from './session.js';
import { SHORTCUTS } from './shortcuts.js';
import { useTheme } from './theme.js';

function initials(email: string): string {
  const name = email.split('@')[0] ?? email;
  const parts = name.split(/[._-]+/).filter(Boolean);
  const first = parts[0] ?? name;
  const second = parts[1];
  return (second ? `${first.charAt(0)}${second.charAt(0)}` : first.slice(0, 2)).toUpperCase();
}

/**
 * The left rail: brand, the eight sections (Board · Processes · Sources · Destinations · Activity ·
 * Approvals · Plugins · Settings) with counts and badges, keyboard hints and the signed-in user.
 * Collapses to icons at tablet width and to a bottom bar on phones.
 */
export function Rail({ onSignOut }: { onSignOut: () => void }) {
  const { user } = useSession();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const processes = useProcesses();
  const status = useStatus();
  const plugins = usePlugins();
  const about = useAbout();

  const pending = status.data?.pendingApprovals ?? 0;
  const pluginTrouble = (plugins.data ?? []).filter((p) => p.status !== 'loaded').length;
  const replicas = about.data?.replicas.filter((r) => r.live).length;

  return (
    <aside className={styles.rail} aria-label="Primary">
      <Link to="/" className={styles.brand} aria-label="AI Switchboard home">
        <Logo size={34} label={null} />
        <span className={styles.brandText}>
          <span className={styles.brandName}>AI Switchboard</span>
          <span className={styles.brandSub}>
            {replicas != null
              ? `${replicas} replica${replicas === 1 ? '' : 's'}`
              : 'operations console'}
          </span>
        </span>
      </Link>

      <nav className={styles.nav} aria-label="Sections">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => cx(styles.item, isActive && styles.active)}
          >
            <Icon name={item.icon} />
            <span className={styles.label}>{item.label}</span>
            {item.to === '/processes' && processes.data && (
              <span className={styles.count} aria-label={`${processes.data.length} processes`}>
                {processes.data.length}
              </span>
            )}
            {item.to === '/approvals' && pending > 0 && (
              <span className={styles.badge} aria-label={`${pending} awaiting approval`}>
                {pending}
              </span>
            )}
            {item.to === '/plugins' && pluginTrouble > 0 && (
              <span
                className={styles.badge}
                title={`${pluginTrouble} plugin${pluginTrouble === 1 ? ' needs' : 's need'} attention`}
                aria-label={`${pluginTrouble} plugin${pluginTrouble === 1 ? ' needs' : 's need'} attention`}
              >
                {pluginTrouble}
                <span className={styles.badgeWord} aria-hidden="true">
                  {' '}
                  to fix
                </span>
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className={styles.spacer} />

      <div className={styles.hints} aria-label="Keyboard shortcuts">
        {SHORTCUTS.map((s) => (
          <span key={s.keys}>
            <kbd>{s.keys}</kbd> {s.label}
          </span>
        ))}
      </div>

      {user && (
        <div className={styles.user}>
          <span className={styles.avatar} aria-hidden="true">
            {initials(user.email)}
          </span>
          <span className={styles.who}>
            <span className={styles.email} title={user.email}>
              {user.email}
            </span>
            <span className={styles.role}>{roleLabel(user.role)}</span>
          </span>
          <span className={styles.userActions}>
            <IconButton
              icon={theme === 'dark' ? 'sun' : 'moon'}
              label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
              variant="ghost"
              onClick={toggle}
            />
            <IconButton
              icon="lock"
              label="Account and password"
              variant="ghost"
              onClick={() => {
                void navigate('/settings/account');
              }}
            />
            <IconButton icon="logout" label="Sign out" variant="ghost" onClick={onSignOut} />
          </span>
        </div>
      )}
    </aside>
  );
}
