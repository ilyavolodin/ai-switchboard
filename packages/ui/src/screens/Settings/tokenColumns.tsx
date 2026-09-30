import type { ApiTokenDTO } from '@ai-switchboard/core/contract';

import { roleLabel } from '../../app/session.js';
import { Button } from '../../components/Button.js';
import { StatusChip } from '../../components/StatusChip.js';
import type { TableColumn } from '../../components/Table.js';
import { Time } from '../../components/Time.js';
import styles from './Settings.module.css';

export function tokenColumns(onRevoke: (token: ApiTokenDTO) => void): TableColumn<ApiTokenDTO>[] {
  return [
    { key: 'name', header: 'name', cell: (t) => <span className={styles.itemName}>{t.name}</span> },
    { key: 'role', header: 'role', cell: (t) => roleLabel(t.role) },
    { key: 'created', header: 'created', cell: (t) => <Time value={t.createdAt} /> },
    {
      key: 'used',
      header: 'last used',
      cell: (t) => <Time value={t.lastUsedAt} fallback="never" />,
    },
    {
      key: 'status',
      header: 'status',
      cell: (t) =>
        t.revokedAt ? (
          <StatusChip size="sm" tone="off" label="revoked" />
        ) : (
          <StatusChip size="sm" tone="ok" label="active" />
        ),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">actions</span>,
      align: 'right',
      cell: (t) =>
        t.revokedAt ? null : (
          <Button
            size="sm"
            variant="danger-outline"
            aria-label={`Revoke ${t.name}`}
            onClick={() => {
              onRevoke(t);
            }}
          >
            Revoke
          </Button>
        ),
    },
  ];
}
