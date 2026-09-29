import { type SubmitEvent, type Ref, useState } from 'react';
import { Link, useMatches, useNavigate } from 'react-router';

import { useStatus } from '../api/index.js';
import { SearchInput } from '../components/SearchInput.js';
import { cx } from '../lib/cx.js';
import { CapacityStrip } from './CapacityStrip.js';
import { isRouteHandle } from './nav.js';
import { searchTarget } from './search.js';
import styles from './TopBar.module.css';

export function TopBar({ searchRef }: { searchRef?: Ref<HTMLInputElement> }) {
  const matches = useMatches();
  const navigate = useNavigate();
  const status = useStatus();
  const [query, setQuery] = useState('');
  const handle = [...matches].reverse().find((m) => isRouteHandle(m.handle))?.handle;
  const title = isRouteHandle(handle) ? handle.title : 'AI Switchboard';

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const to = searchTarget(query);
    if (to) {
      void navigate(to);
      setQuery('');
    }
  };

  const breakers = status.data?.openBreakers ?? 0;
  const approvals = status.data?.pendingApprovals ?? 0;

  return (
    <header className={styles.bar}>
      <div className={styles.title}>{title}</div>
      <form role="search" onSubmit={submit} className={styles.search}>
        <SearchInput
          ref={searchRef}
          label="Search by artifact id"
          placeholder="Search LOL-1712, #482, run…"
          shortcut="/"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
      </form>
      <span className={styles.spacer} />
      {status.data && <CapacityStrip meters={status.data.meters} />}
      <div className={styles.chips}>
        {breakers > 0 && (
          <Link
            to="/processes?status=breaker"
            className={cx(styles.chip, styles.err)}
            aria-label={`${breakers} ${breakers === 1 ? 'breaker' : 'breakers'} open`}
          >
            <span
              className={styles.chipDot}
              style={{ background: 'var(--st-err)' }}
              aria-hidden="true"
            />
            <span className="mono">{breakers}</span>
            <span className={styles.chipWord}>{breakers === 1 ? 'breaker' : 'breakers'}</span>
          </Link>
        )}
        {approvals > 0 && (
          <Link
            to="/approvals"
            className={cx(styles.chip, styles.warn)}
            aria-label={`${approvals} ${approvals === 1 ? 'approval' : 'approvals'} pending`}
          >
            <span
              className={styles.chipDot}
              style={{ background: 'var(--st-warn)' }}
              aria-hidden="true"
            />
            <span className="mono">{approvals}</span>
            <span className={styles.chipWord}>{approvals === 1 ? 'approval' : 'approvals'}</span>
          </Link>
        )}
      </div>
    </header>
  );
}
