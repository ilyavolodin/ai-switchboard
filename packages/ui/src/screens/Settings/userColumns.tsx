import type { Role, UserDirectoryEntry, UserDTO } from '@ai-switchboard/core/contract';

import { Button } from '../../components/Button.js';
import { Select } from '../../components/Select.js';
import { StatusChip } from '../../components/StatusChip.js';
import type { TableColumn } from '../../components/Table.js';
import { Time } from '../../components/Time.js';
import { Tooltip } from '../../components/Tooltip.js';
import styles from './Settings.module.css';
import { UserIdentity } from './UserIdentity.js';
import { isRole, ROLE_OPTIONS } from './users.js';

export interface UserRowActions {
  changeRole: (user: UserDTO, role: Role) => void;
  setPassword: (user: UserDTO) => void;
  removePassword: (user: UserDTO) => void;
  revoke: (user: UserDTO) => void;
  remove: (user: UserDTO) => void;
}

function identity<T extends UserDirectoryEntry>(meId: string | undefined): TableColumn<T> {
  return {
    key: 'email',
    header: 'email',
    cell: (u) => <UserIdentity email={u.email} you={u.id === meId} />,
  };
}

/** What a non-admin sees: the same controls, disabled with the role they need. */
export function directoryColumns(
  meId: string | undefined,
  needsAdmin: string,
): TableColumn<UserDirectoryEntry>[] {
  return [
    identity(meId),
    {
      key: 'role',
      header: 'role',
      width: 140,
      cell: (u) => (
        <Tooltip content={needsAdmin}>
          <Select
            size="sm"
            aria-label={`Role for ${u.email}`}
            value={u.role}
            options={ROLE_OPTIONS}
            disabled
            onChange={() => undefined}
          />
        </Tooltip>
      ),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">actions</span>,
      align: 'right',
      cell: (u) => (
        <span className={styles.rowActions}>
          {['Set password', 'Revoke sessions'].map((label) => (
            <Button
              key={label}
              size="sm"
              variant="ghost"
              requires="admin"
              aria-label={`${label} for ${u.email}`}
            >
              {label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="danger-outline"
            requires="admin"
            aria-label={`Remove ${u.email}`}
          >
            Remove
          </Button>
        </span>
      ),
    },
  ];
}

export function adminColumns(
  meId: string | undefined,
  oidcConfigured: boolean,
  actions: UserRowActions,
): TableColumn<UserDTO>[] {
  return [
    identity(meId),
    {
      key: 'role',
      header: 'role',
      width: 140,
      cell: (u) => {
        const self = u.id === meId;
        const select = (
          <Select
            size="sm"
            aria-label={`Role for ${u.email}`}
            value={u.role}
            options={ROLE_OPTIONS}
            disabled={self}
            onChange={(e) => {
              const role = e.target.value;
              if (isRole(role) && role !== u.role) actions.changeRole(u, role);
            }}
          />
        );
        return self ? <Tooltip content="You can’t change your own role">{select}</Tooltip> : select;
      },
    },
    {
      key: 'signIn',
      header: 'sign-in',
      cell: (u) => (
        <span className={styles.rowActions}>
          {u.hasPassword && (
            <StatusChip
              size="sm"
              tone={u.mustChangePassword ? 'warn' : 'ok'}
              label={u.mustChangePassword ? 'temporary password' : 'password'}
            />
          )}
          {u.hasOidc && <StatusChip size="sm" tone="ok" label="OIDC" />}
          {!u.hasPassword && !u.hasOidc && (
            <StatusChip size="sm" tone="off" label="not yet signed in" />
          )}
        </span>
      ),
    },
    {
      key: 'last',
      header: 'last sign-in',
      cell: (u) => <Time value={u.lastLoginAt} fallback="never" />,
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">actions</span>,
      align: 'right',
      cell: (u) => {
        const self = u.id === meId;
        return (
          <span className={styles.rowActions}>
            <Button
              size="sm"
              variant="ghost"
              requires="admin"
              disabled={self}
              disabledReason="Change your own password from your account"
              aria-label={`${u.hasPassword ? 'Reset' : 'Set'} password for ${u.email}`}
              onClick={() => {
                actions.setPassword(u);
              }}
            >
              {u.hasPassword ? 'Reset password' : 'Set password'}
            </Button>
            {u.hasPassword && oidcConfigured && (
              <Button
                size="sm"
                variant="ghost"
                requires="admin"
                aria-label={`Remove password for ${u.email}`}
                onClick={() => {
                  actions.removePassword(u);
                }}
              >
                Remove password
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              requires="admin"
              aria-label={`Revoke sessions for ${u.email}`}
              onClick={() => {
                actions.revoke(u);
              }}
            >
              Revoke sessions
            </Button>
            <Button
              size="sm"
              variant="danger-outline"
              requires="admin"
              disabled={self}
              disabledReason="You can’t remove yourself"
              aria-label={`Remove ${u.email}`}
              onClick={() => {
                actions.remove(u);
              }}
            >
              Remove
            </Button>
          </span>
        );
      },
    },
  ];
}
