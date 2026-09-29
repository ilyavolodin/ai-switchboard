import type { AuditEntry } from '@ai-switchboard/core/contract';
import type { SubmitEvent } from 'react';
import { useSearchParams } from 'react-router';

import { useAudit } from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { LoadMore } from '../../components/LoadMore.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Table, type TableColumn } from '../../components/Table.js';
import { TextField } from '../../components/TextField.js';
import { Time } from '../../components/Time.js';
import { QueryError } from '../../components/QueryError.js';
import { AUDIT_SCOPES, changeLines } from './audit.js';
import { useFlatPages } from '../../hooks/useFlatPages.js';
import { useSearchParamState } from '../../hooks/useSearchParamState.js';
import styles from './Settings.module.css';
import { initials } from './settingsForm.js';

function Change({ entry }: { entry: AuditEntry }) {
  const lines = changeLines(entry.before, entry.after);
  return (
    <span className={styles.change}>
      {lines.map((l, i) => (
        <span key={l.key ?? i}>
          {l.key && <span className={styles.changeKey}>{l.key}: </span>}
          <span className={styles.before}>{l.before}</span>
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
          <span className="visually-hidden"> changed to </span>
          <span className={styles.after}>{l.after}</span>
        </span>
      ))}
    </span>
  );
}

const COLUMNS: TableColumn<AuditEntry>[] = [
  { key: 'at', header: 'time', cell: (e) => <Time value={e.at} format="when" /> },
  {
    key: 'actor',
    header: 'actor',
    cell: (e) => (
      <span className={styles.who}>
        <span className={styles.avatar} aria-hidden="true">
          {initials(e.actor)}
        </span>
        {e.actor}
      </span>
    ),
  },
  { key: 'scope', header: 'scope', cell: (e) => <span className="t-caption">{e.scope}</span> },
  {
    key: 'target',
    header: 'target',
    cell: (e) => <span className={styles.itemName}>{e.targetName ?? e.targetId ?? '—'}</span>,
  },
  { key: 'field', header: 'field', mono: true, cell: (e) => e.field ?? '—' },
  { key: 'change', header: 'before → after', cell: (e) => <Change entry={e} /> },
  {
    key: 'reason',
    header: 'reason',
    cell: (e) => <span className="t-caption">{e.reason ?? '—'}</span>,
  },
];

export function AuditTab() {
  const [, setParams] = useSearchParams();
  const [scope, setScope] = useSearchParamState('scope');
  const [actor, setActor] = useSearchParamState('actor');
  const audit = useAudit({ scope: scope || undefined, actor: actor || undefined });
  const rows = useFlatPages(audit);

  const onActor = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = new FormData(e.currentTarget).get('actor');
    setActor(typeof v === 'string' ? v.trim() : '');
  };

  return (
    <Card title="Audit log" subtitle="every change, by whom, and why">
      <div className={styles.filters} role="group" aria-label="Audit filters">
        <Select
          size="sm"
          aria-label="Scope"
          value={scope}
          placeholder="All scopes"
          options={AUDIT_SCOPES.map((s) => ({ value: s, label: s.replace('_', ' ') }))}
          onChange={(e) => {
            setScope(e.target.value);
          }}
        />
        <form className={styles.filterForm} onSubmit={onActor}>
          <TextField
            key={actor}
            name="actor"
            size="sm"
            aria-label="Actor"
            placeholder="actor email"
            defaultValue={actor}
            onBlur={(e) => {
              if (e.target.value.trim() !== actor) setActor(e.target.value.trim());
            }}
          />
        </form>
        {(scope || actor) && (
          <Button
            size="sm"
            variant="ghost"
            icon="close"
            onClick={() => {
              setParams({}, { replace: true });
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      {audit.isPending ? (
        <Skeleton lines={6} height={24} label="Loading the audit log" />
      ) : audit.isError ? (
        <QueryError query={audit} title="The audit log could not load" />
      ) : (
        <>
          <Table
            caption="Audit log"
            columns={COLUMNS}
            rows={rows}
            rowKey={(e) => String(e.id)}
            empty={scope || actor ? 'No changes match these filters.' : 'No changes yet.'}
          />
          <LoadMore
            hasMore={audit.hasNextPage}
            loading={audit.isFetchingNextPage}
            onLoadMore={() => void audit.fetchNextPage()}
          />
        </>
      )}
    </Card>
  );
}
