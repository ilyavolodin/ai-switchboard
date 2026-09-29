import type { PluginSearchKind, PluginSearchResult } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { errorMessage, isApiRequestError } from '../../api/client.js';
import { usePluginSearch } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Icon } from '../../components/Icon.js';
import { SearchInput } from '../../components/SearchInput.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { useDebounced } from '../../hooks/useDebounced.js';
import { cx } from '../../lib/cx.js';
import { formatCount } from '../../lib/format.js';
import styles from './Plugins.module.css';
import { kindLabel } from './pluginModel.js';

type KindFilter = PluginSearchKind | 'all';

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'source', label: 'Sources' },
  { value: 'destination', label: 'Destinations' },
  { value: 'notifier', label: 'Notifiers' },
  { value: 'secrets', label: 'Secret providers' },
];

export interface NpmSearchProps {
  kind?: PluginSearchKind;
  onInstall: (result: PluginSearchResult) => void;
  compact?: boolean;
}

export function NpmSearch({ kind, onInstall, compact = false }: NpmSearchProps) {
  const [filter, setFilter] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const effective = kind ?? (filter === 'all' ? undefined : filter);
  const search = usePluginSearch(effective, q);

  let body;
  if (search.isPending) {
    body = <Skeleton lines={3} height={compact ? 48 : 96} label="Searching npm" />;
  } else if (search.isError) {
    const offline = isApiRequestError(search.error) && search.error.status === 503;
    body = (
      <Banner tone={offline ? 'warn' : 'error'} title="npm could not be searched">
        {errorMessage(search.error)}
      </Banner>
    );
  } else if (search.data.results.length === 0) {
    body = (
      <EmptyState title="No plugins match" compact>
        Plugins are found by name:{' '}
        <span className="mono">ai-switchboard-{effective ?? 'kind'}-…</span> or{' '}
        <span className="mono">@scope/ai-switchboard-{effective ?? 'kind'}-…</span>. Any other
        package can be added by name on the Plugins page.
      </EmptyState>
    );
  } else {
    body = (
      <ul className={cx(styles.catalogue, compact && styles.compact)} aria-label="npm packages">
        {search.data.results.map((r) => (
          <li key={r.package} className={styles.entry} aria-label={r.package}>
            <span className={styles.entryHead}>
              <span className={styles.kind}>{kindLabel(r.kind)}</span>
              <span className="mono">{r.version}</span>
              {r.weeklyDownloads !== null && <span>{formatCount(r.weeklyDownloads)} / week</span>}
            </span>
            <span className={styles.pkgName}>{r.package}</span>
            {r.description && <p className={styles.description}>{r.description}</p>}
            <span className={styles.sub}>
              {r.publisher ? `by ${r.publisher}` : 'publisher unknown'}
              {r.date && (
                <>
                  {' · '}
                  <Time value={r.date} />
                </>
              )}
            </span>
            <span className={styles.entryFoot}>
              {r.reviewed && <StatusChip tone="ok" size="sm" label="reviewed" />}
              {r.links.npm && (
                <a href={r.links.npm} target="_blank" rel="noreferrer" className="t-caption">
                  npm <Icon name="external" size={11} />
                </a>
              )}
              {r.links.homepage && (
                <a href={r.links.homepage} target="_blank" rel="noreferrer" className="t-caption">
                  homepage <Icon name="external" size={11} />
                </a>
              )}
              <span className={styles.spacer} />
              {r.installed ? (
                <StatusChip
                  tone="off"
                  size="sm"
                  label={r.installedVersion ? `installed · ${r.installedVersion}` : 'installed'}
                />
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  icon="plus"
                  requires="admin"
                  aria-label={`Install ${r.package}`}
                  onClick={() => {
                    onInstall(r);
                  }}
                >
                  Install
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className={styles.browse}>
      <div className={styles.browseBar}>
        {kind === undefined && (
          <SegmentedControl
            label="Plugin kind"
            options={KIND_OPTIONS}
            value={filter}
            onChange={setFilter}
          />
        )}
        <SearchInput
          label="Search npm"
          placeholder={
            kind
              ? `search ${kindLabel(kind === 'secrets' ? 'secret_provider' : kind)} plugins`
              : 'search plugins'
          }
          className={styles.search}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        {search.data && (
          <span className="t-caption">{search.data.registry.replace(/^https?:\/\//, '')}</span>
        )}
      </div>
      {body}
    </div>
  );
}
