import { useParams } from 'react-router';

import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LinkButton } from '../../components/LinkButton.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { AboutTab } from './AboutTab.js';
import { AuditTab } from './AuditTab.js';
import { ExportTab } from './ExportTab.js';
import { GeneralTab } from './GeneralTab.js';
import { InstancesTab } from './InstancesTab.js';
import { RetentionTab } from './RetentionTab.js';
import styles from './Settings.module.css';
import { SignInTab } from './SignInTab.js';
import { SETTINGS_TABS, type SettingsTabId, settingsHref, settingsTab } from './tabs.js';
import { TokensTab } from './TokensTab.js';
import { UsersTab } from './UsersTab.js';

/**
 * Settings (`/settings`, `/settings/:tab`): General, Sign-in, Users, API tokens, Notifiers,
 * Secret providers, Retention, Export, About and the Audit log. Every save asks for a reason.
 */
export function Settings() {
  const { tab: segment } = useParams();
  const tab = settingsTab(segment);
  return (
    <>
      <h1 className="t-screen-title">Settings</h1>
      <div className={styles.tabs}>
        <RoutedTabs
          label="Settings sections"
          items={SETTINGS_TABS.map((t) => ({
            to: settingsHref(t.id),
            label: t.label,
            end: t.id === 'general',
          }))}
        />
      </div>
      {tab == null ? (
        <Card>
          <EmptyState
            title={`There is no “${segment ?? ''}” section`}
            actions={
              <LinkButton to="/settings" variant="outline" size="sm">
                Open General
              </LinkButton>
            }
          >
            Pick one of the sections above.
          </EmptyState>
        </Card>
      ) : (
        <TabBody tab={tab} />
      )}
    </>
  );
}

function TabBody({ tab }: { tab: SettingsTabId }) {
  switch (tab) {
    case 'general':
      return <GeneralTab />;
    case 'sign-in':
      return <SignInTab />;
    case 'users':
      return <UsersTab />;
    case 'tokens':
      return <TokensTab />;
    case 'notifiers':
      return <InstancesTab route="notifiers" />;
    case 'secret-providers':
      return <InstancesTab route="secret-providers" />;
    case 'retention':
      return <RetentionTab />;
    case 'export':
      return <ExportTab />;
    case 'about':
      return <AboutTab />;
    case 'audit':
      return <AuditTab />;
  }
}
