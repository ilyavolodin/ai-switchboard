import type { SourceSummary } from '@ai-switchboard/core/contract';

import { useSourceStats } from '../../api/index.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { cx } from '../../lib/cx.js';
import { formatCount } from '../../lib/format.js';
import { sourceHref } from '../../lib/hrefs.js';
import { cardTone } from '../../lib/instances.js';
import { InstanceCardHeader } from '../shared/InstanceCardHeader.js';
import styles from '../shared/instanceCard.module.css';
import { hourlyTotals, modeLabel, typeSplit } from './sourceModel.js';
import { useSourceActions } from './useSourceActions.js';

export function SourceCard({ source }: { source: SourceSummary }) {
  // One stats request per enabled card: the list response has no hourly buckets.
  const stats = useSourceStats(source.enabled ? source.id : undefined, '24h');
  const actions = useSourceActions(source);
  const { total, parts } = typeSplit(source);
  const hours = hourlyTotals(stats.data);
  const peak = Math.max(1, ...hours.map((h) => h.total));
  const tone = cardTone(source.enabled, source.status.tone);

  return (
    <article className={styles.card} data-tone={tone ?? undefined} aria-label={source.name}>
      <InstanceCardHeader
        kind="source"
        name={source.name}
        icon={source.typeIcon}
        href={sourceHref(source.id)}
        meta={`${source.typeName} · ${modeLabel(source.mode)}`}
        enabled={source.enabled}
        onEnabledChange={actions.setEnabled}
      />

      <div className={styles.statusLine}>
        <StatusChip tone={source.status.tone} label={source.status.label} size="sm" />
        <span className={styles.muted}>
          · last event <Time value={source.lastEventAt} fallback="never" />
        </span>
      </div>

      {(!source.pluginAvailable || source.unauthenticated) && (
        <div className={styles.chips}>
          {!source.pluginAvailable && (
            <StatusChip tone="warn" label="plugin unavailable" size="sm" />
          )}
          {source.unauthenticated && <StatusChip tone="error" label="unauthenticated" size="sm" />}
        </div>
      )}

      <div className={styles.stack}>
        <div className={styles.row}>
          <span>events · 24 h</span>
          <span className="mono">{source.enabled ? formatCount(total) : '—'}</span>
        </div>
        <div
          className={cx(styles.histogram, total === 0 && styles.histogramEmpty)}
          aria-hidden="true"
        >
          {total > 0 &&
            hours.map((h, i) => {
              const throttled = h.total ? (h.throttled / h.total) * 100 : 0;
              return (
                <span
                  key={i}
                  className={styles.bar}
                  style={{
                    height: `${(h.total / peak) * 100}%`,
                    background:
                      throttled > 0
                        ? `linear-gradient(to top, var(--primary) ${100 - throttled}%, var(--st-warn) ${100 - throttled}%)`
                        : 'var(--primary)',
                  }}
                />
              );
            })}
        </div>
      </div>

      {source.enabled ? (
        <div className={styles.stack}>
          <div
            className={styles.split}
            role="img"
            aria-label={
              parts.length
                ? `Events by type in 24 h: ${parts.map((p) => `${p.type} ${p.count}`).join(', ')}`
                : 'No events in 24 h'
            }
          >
            {parts.length ? (
              parts.map((p) => (
                <span
                  key={p.type}
                  className={styles.segment}
                  title={`${p.type} ${p.count}`}
                  style={{ width: `${p.share * 100}%`, background: p.color }}
                />
              ))
            ) : (
              <span className={styles.splitEmpty} />
            )}
          </div>
          {parts.length > 0 && (
            <div className={styles.legend} aria-hidden="true">
              {parts.map((p) => (
                <span key={p.type}>
                  <span className={styles.dot} style={{ background: p.color }} />
                  {p.type}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <span className={styles.foot}>Events are kept while disabled and can be replayed.</span>
      )}
    </article>
  );
}
