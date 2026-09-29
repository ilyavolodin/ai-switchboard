import type { PluginSearchResult, PluginTypeDTO } from '@ai-switchboard/core/contract';

import { Banner } from '../../components/Banner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Skeleton } from '../../components/Skeleton.js';
import { TypeIcon } from '../../components/TypeIcon.js';
import styles from './forms.module.css';
import { NpmSearch } from './NpmSearch.js';

export interface TypePickerProps {
  kind: 'source' | 'destination';
  types: PluginTypeDTO[];
  loading: boolean;
  /** Set while an installed plugin's types are on their way. */
  awaiting: boolean;
  installNote: string | null;
  describeType: (type: PluginTypeDTO) => string;
  onChoose: (type: PluginTypeDTO) => void;
  onReview: (result: PluginSearchResult) => void;
}

export function TypePicker({
  kind,
  types,
  loading,
  awaiting,
  installNote,
  describeType,
  onChoose,
  onReview,
}: TypePickerProps) {
  return (
    <div className={styles.stack}>
      {installNote && (
        <Banner tone="warn" title="Not ready yet">
          {installNote}
        </Banner>
      )}
      {awaiting && <Skeleton lines={1} height={32} label="Loading the new type" />}
      {loading ? (
        <Skeleton lines={3} height={48} label={`Loading ${kind} types`} />
      ) : types.length === 0 ? (
        <EmptyState title={`No ${kind} types are installed`} compact>
          {kind === 'source' ? 'Source' : 'Destination'} types come from plugins. Find one on npm
          below, or an admin can add any package on the Plugins page.
        </EmptyState>
      ) : (
        <>
          <p className={styles.note}>
            Pick a type. Each type comes from an installed plugin; its settings form is the
            plugin&apos;s own.
          </p>
          <div className={styles.typeGrid} role="list" aria-label={`${kind} types`}>
            {types.map((t) => (
              <div role="listitem" key={t.typeId}>
                <button
                  type="button"
                  className={`${styles.typeOption} ${styles.block}`}
                  aria-disabled={t.available ? undefined : true}
                  onClick={() => {
                    if (t.available) onChoose(t);
                  }}
                >
                  <span className={styles.iconTile}>
                    <TypeIcon icon={t.icon} kind={kind} />
                  </span>
                  <span className={styles.typeText}>
                    <span className={styles.typeName}>{t.displayName}</span>
                    <span className={styles.typeMeta}>
                      {t.available ? describeType(t) : 'plugin unavailable'}
                    </span>
                    <span className={`${styles.typeMeta} mono`}>{t.plugin}</span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <section className={styles.stack} aria-label="Find more on npm">
        <span className={styles.legend}>Find more on npm</span>
        <NpmSearch kind={kind} compact onInstall={onReview} />
      </section>
    </div>
  );
}
