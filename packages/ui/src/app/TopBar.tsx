import type { Ref } from 'react';
import { Link, useMatches } from 'react-router';

import { useStatus } from '../api/index.js';
import { ToneDot } from '../components/ToneDot.js';
import { TraceSearchForm } from '../components/TraceSearchForm.js';
import { cx } from '../lib/cx.js';
import { pluralWord } from '../lib/format.js';
import { CapacityStrip } from './CapacityStrip.js';
import { isRouteHandle } from './nav.js';
import styles from './TopBar.module.css';

export function TopBar({ searchRef }: { searchRef?: Ref<HTMLInputElement> }) {
  const matches = useMatches();
  const status = useStatus();
  const handle = [...matches].reverse().find((m) => isRouteHandle(m.handle))?.handle;
  const title = isRouteHandle(handle) ? handle.title : 'AI Switchboard';

  const breakers = status.data?.openBreakers ?? 0;
  const approvals = status.data?.pendingApprovals ?? 0;

  return (
    <header className={styles.bar}>
      <div className={styles.title}>{title}</div>
      <TraceSearchForm
        className={styles.search}
        inputRef={searchRef}
        label="Search by artifact id"
        placeholder="Search LOL-1712, #482, run…"
        shortcut="/"
        mono={false}
        clearOnSubmit
      />
      <span className={styles.spacer} />
      {status.data && <CapacityStrip meters={status.data.meters} />}
      <div className={styles.chips}>
        {breakers > 0 && (
          <Link
            to="/processes?status=breaker"
            className={cx(styles.chip, styles.err)}
            aria-label={`${breakers} ${pluralWord(breakers, 'breaker')} open`}
          >
            <ToneDot tone="error" />
            <span className="mono">{breakers}</span>
            <span className={styles.chipWord}>{pluralWord(breakers, 'breaker')}</span>
          </Link>
        )}
        {approvals > 0 && (
          <Link
            to="/approvals"
            className={cx(styles.chip, styles.warn)}
            aria-label={`${approvals} ${pluralWord(approvals, 'approval')} pending`}
          >
            <ToneDot tone="warn" />
            <span className="mono">{approvals}</span>
            <span className={styles.chipWord}>{pluralWord(approvals, 'approval')}</span>
          </Link>
        )}
      </div>
    </header>
  );
}
