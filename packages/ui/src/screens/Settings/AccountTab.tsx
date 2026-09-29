import { useMe } from '../../api/index.js';
import { roleLabel, useSession } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Card } from '../../components/Card.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { StatusChip } from '../../components/StatusChip.js';
import { useToast } from '../../hooks/toast.js';
import { ChangePasswordForm } from '../ChangePassword/ChangePasswordForm.js';
import styles from './Settings.module.css';

export function AccountTab() {
  const session = useSession();
  const me = useMe();
  const toast = useToast();
  const user = me.data?.user ?? session.user;
  if (!user) return null;
  return (
    <div className={styles.stack}>
      <Card title="Account">
        <KeyValueList
          label="Account"
          data={[
            ['email', user.email],
            ['role', roleLabel(user.role)],
            [
              'sign-in',
              <span key="methods" className={styles.rowActions}>
                {user.hasPassword && <StatusChip size="sm" tone="ok" label="password" />}
                {user.hasOidc && <StatusChip size="sm" tone="ok" label="OIDC" />}
              </span>,
            ],
          ]}
        />
      </Card>
      <Card title="Password" subtitle="Changing it signs you out of your other sessions">
        {user.hasPassword ? (
          <div className={styles.passwordForm}>
            <ChangePasswordForm
              email={user.email}
              onChanged={() => {
                toast({ tone: 'ok', title: 'Password changed' });
              }}
            />
          </div>
        ) : (
          <Banner tone="info" title="No local password">
            This account signs in through OIDC. Ask an admin to set a password if you need one.
          </Banner>
        )}
      </Card>
    </div>
  );
}
