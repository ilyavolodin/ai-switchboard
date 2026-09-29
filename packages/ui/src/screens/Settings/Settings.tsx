import { useParams } from 'react-router';

import { Card } from '../../components/Card.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { UnknownTab } from '../shared/UnknownTab.js';
import { AboutTab } from './AboutTab.js';
import { AccountTab } from './AccountTab.js';
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
          <UnknownTab
            to="/settings"
            label="Open General"
            title={`There is no “${segment ?? ''}” section`}
          />
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
    case 'account':
      return <AccountTab />;
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
