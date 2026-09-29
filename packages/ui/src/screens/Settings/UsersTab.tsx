import type { UserDTO } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { useUserDirectory, useUsers } from '../../api/index.js';
import { roleLabel, roleRequiredMessage, useCan, useSession } from '../../app/session.js';
import { Card } from '../../components/Card.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Table } from '../../components/Table.js';
import { AddUserCard } from './AddUserCard.js';
import { SetPasswordDialog } from './SetPasswordDialog.js';
import styles from './Settings.module.css';
import { useUserActions } from './useUserActions.js';
import { adminColumns, directoryColumns } from './userColumns.js';

const loading = <Skeleton lines={4} height={24} label="Loading users" />;

export function UsersTab() {
  const isAdmin = useCan('admin');
  return isAdmin ? <UsersAdmin /> : <UsersReadOnly />;
}

function UsersReadOnly() {
  const directory = useUserDirectory();
  const { user: me } = useSession();
  const columns = directoryColumns(me?.id, roleRequiredMessage('admin', me?.role));
  return (
    <div className={styles.stack}>
      <AddUserCard />
      <Card
        title="Users"
        subtitle={`You are ${me ? roleLabel(me.role) : 'signed in'}: adding people and changing roles needs the Admin role`}
      >
        <QueryBoundary query={directory} errorTitle="Users could not load" pending={loading}>
          {(rows) => <Table caption="Users" columns={columns} rows={rows} rowKey={(u) => u.id} />}
        </QueryBoundary>
      </Card>
    </div>
  );
}

function UsersAdmin() {
  const users = useUsers();
  const { user: me, oidcConfigured } = useSession();
  const [passwordFor, setPasswordFor] = useState<UserDTO | null>(null);
  const emailOf = (id: string): string =>
    users.data?.find((u) => u.id === id)?.email ?? 'this user';
  const act = useUserActions(emailOf);
  const columns = adminColumns(me?.id, oidcConfigured, {
    changeRole: (u, role) => void act.updateRole.run({ id: u.id, role }),
    setPassword: setPasswordFor,
    removePassword: (u) => void act.removePassword.run({ id: u.id }),
    revoke: (u) => void act.revoke.run({ id: u.id }),
    remove: (u) => void act.remove.run({ id: u.id }),
  });

  return (
    <div className={styles.stack}>
      <AddUserCard />
      <Card title="Users" subtitle="admin · operator · viewer — every change is audited">
        <QueryBoundary query={users} errorTitle="Users could not load" pending={loading}>
          {(rows) => <Table caption="Users" columns={columns} rows={rows} rowKey={(u) => u.id} />}
        </QueryBoundary>
      </Card>
      <SetPasswordDialog
        email={passwordFor?.email ?? null}
        reset={passwordFor?.hasPassword ?? false}
        onClose={() => {
          setPasswordFor(null);
        }}
        onSubmit={(password) => {
          const target = passwordFor;
          setPasswordFor(null);
          if (target) void act.setPassword.run({ id: target.id, password });
        }}
      />
    </div>
  );
}
