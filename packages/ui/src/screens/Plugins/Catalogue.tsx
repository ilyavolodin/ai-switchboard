import type { CatalogueEntry } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Icon } from '../../components/Icon.js';
import { SearchInput } from '../../components/SearchInput.js';
import { StatusChip } from '../../components/StatusChip.js';
import styles from './Plugins.module.css';
import { kindLabel } from './pluginModel.js';

/** The Catalogue tab: the project's reviewed plugins, each with one-click Add. */
export function Catalogue({
  entries,
  onAdd,
}: {
  entries: CatalogueEntry[];
  onAdd: (entry: CatalogueEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = entries.filter(
    (e) =>
      !q ||
      e.package.toLowerCase().includes(q) ||
      e.displayName.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q),
  );
  return (
    <>
      <SearchInput
        label="Search the catalogue"
        placeholder="package name"
        className={styles.search}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
      />
      {shown.length === 0 ? (
        <EmptyState title="Nothing matches" compact>
          Any npm package with a switchboard manifest can be added by name with Add plugin.
        </EmptyState>
      ) : (
        <ul className={styles.catalogue} aria-label="Catalogue">
          {shown.map((e) => (
            <li key={e.package} className={styles.entry} aria-label={e.displayName}>
              <span className={styles.entryHead}>
                {e.kinds.map((k) => (
                  <span key={k} className={styles.kind}>
                    {kindLabel(k)}
                  </span>
                ))}
                <span className="mono">{e.latestVersion}</span>
              </span>
              <span className={styles.pkgName}>{e.package}</span>
              <p className={styles.description}>{e.description}</p>
              <span className={styles.entryFoot}>
                {e.reviewed && <StatusChip tone="ok" size="sm" label="reviewed" />}
                {e.homepage && (
                  <a href={e.homepage} target="_blank" rel="noreferrer" className="t-caption">
                    homepage <Icon name="external" size={11} />
                  </a>
                )}
                <span className={styles.spacer} />
                {e.installed ? (
                  <StatusChip tone="off" size="sm" label="installed" />
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    icon="plus"
                    requires="admin"
                    aria-label={`Add ${e.package}`}
                    onClick={() => {
                      onAdd(e);
                    }}
                  >
                    Add
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
