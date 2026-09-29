import type {
  InstanceSummary,
  ProviderSecretDTO,
  SecretOwnerDTO,
  SecretUserDTO,
} from '@ai-switchboard/core/contract';
import { Link } from 'react-router';

import { useProviderSecrets } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Table, type TableColumn } from '../../components/Table.js';
import { Time } from '../../components/Time.js';
import { CopyButton } from '../../components/CopyButton.js';
import { QueryError } from '../../components/QueryError.js';
import styles from './ProviderSecrets.module.css';

const KIND_LABEL: Record<SecretUserDTO['kind'], string> = {
  source: 'source',
  destination: 'destination',
  notifier: 'notifier',
  secret_provider: 'secret provider',
  process: 'process',
};

function hrefFor(user: SecretUserDTO): string {
  switch (user.kind) {
    case 'source':
      return `/sources/${encodeURIComponent(user.id)}`;
    case 'destination':
      return `/destinations/${encodeURIComponent(user.id)}`;
    case 'process':
      return `/processes/${encodeURIComponent(user.id)}`;
    case 'notifier':
      return '/settings/notifiers';
    case 'secret_provider':
      return '/settings/secret-providers';
  }
}

function UsedBy({ users }: { users: SecretUserDTO[] }) {
  if (users.length === 0) return <span className="t-caption">not used</span>;
  return (
    <ul className={styles.users}>
      {users.map((u) => (
        <li key={`${u.kind}:${u.id}:${u.field}`}>
          <Link to={hrefFor(u)} title={`${KIND_LABEL[u.kind]} · field ${u.field}`}>
            {u.name}
          </Link>{' '}
          <span className={styles.field}>{u.field}</span>
        </li>
      ))}
    </ul>
  );
}

function Ref({ value }: { value: string }) {
  return (
    <span className={styles.ref}>
      {value}
      <CopyButton value={value} label={`Copy ${value}`} />
    </span>
  );
}

/** A rotated credential the host keeps for an instance: read-only, never a settings reference. */
function StoredBy({ owner }: { owner: SecretOwnerDTO }) {
  return (
    <span className="t-caption">
      stored by <Link to={hrefFor({ ...owner, field: '' })}>{owner.name}</Link> · read-only
    </span>
  );
}

const columns: TableColumn<ProviderSecretDTO>[] = [
  { key: 'name', header: 'Name', mono: true, cell: (s) => s.name },
  {
    key: 'ref',
    header: 'Reference',
    cell: (s) => (s.storedBy ? <StoredBy owner={s.storedBy} /> : <Ref value={s.ref} />),
  },
  { key: 'used', header: 'Used by', cell: (s) => <UsedBy users={s.usedBy} /> },
  { key: 'updated', header: 'Updated', cell: (s) => <Time value={s.updatedAt} /> },
];

/** Names only, never values. */
export function ProviderSecrets({ instance }: { instance: InstanceSummary }) {
  const secrets = useProviderSecrets(instance.id);
  const title = `Secrets in ${instance.name}`;
  return (
    <section className={styles.panel} aria-label={title}>
      {secrets.isPending ? (
        <Skeleton lines={3} height={20} label={`Loading ${title.toLowerCase()}`} />
      ) : secrets.isError ? (
        <QueryError query={secrets} title="Secrets could not load" />
      ) : !secrets.data.available ? (
        <EmptyState title="This provider cannot list its secrets" compact>
          {secrets.data.error ?? 'Its plugin does not support listing.'} References to it still
          resolve as usual.
        </EmptyState>
      ) : (
        <>
          <h4 className={styles.heading}>
            Secrets
            <StatusChip
              size="sm"
              tone="off"
              label={`${secrets.data.secrets.length} listed · names only`}
            />
          </h4>
          <Table
            caption={title}
            columns={columns}
            rows={secrets.data.secrets}
            rowKey={(s) => s.name}
            empty="The provider lists no secrets."
          />
          {secrets.data.missing.length > 0 && (
            <Banner
              tone="warn"
              title={`Missing · ${secrets.data.missing.length} referenced but not in ${instance.name}`}
            >
              <ul className={styles.missing} aria-label={`Missing from ${instance.name}`}>
                {secrets.data.missing.map((m) => (
                  <li key={m.name} className={styles.missingItem}>
                    <StatusChip size="sm" tone="warn" label="missing" />
                    <Ref value={m.ref} />
                    <UsedBy users={m.usedBy} />
                  </li>
                ))}
              </ul>
            </Banner>
          )}
        </>
      )}
    </section>
  );
}
