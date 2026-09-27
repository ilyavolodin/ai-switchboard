import type { ExecutorSummary } from '@ai-switchboard/core/contract';
import { Link } from 'react-router';

import { useEnableExecutor } from '../../api/index.js';
import { Countdown } from '../../components/Countdown.js';
import { Icon } from '../../components/Icon.js';
import { MeterGauge } from '../../components/MeterGauge.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Toggle } from '../../components/Toggle.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { cardTone, typeIcon } from '../../lib/instances.js';
import styles from '../Sources/instanceCard.module.css';
import { enableExecutorPrompt } from './executorModel.js';

/**
 * One executor instance: type icon, name (links to the detail), health, its meters as arcs with
 * reset countdowns, the soft-hold chip when a backend asked Switchboard to back off, and the
 * enabled toggle.
 */
export function ExecutorCard({ executor }: { executor: ExecutorSummary }) {
  const enable = useReasonedMutation(useEnableExecutor(), (v: { id: string; enabled: boolean }) =>
    enableExecutorPrompt(executor, v.enabled),
  );
  const tone = cardTone(executor.enabled, executor.status.tone);
  return (
    <article className={styles.card} data-tone={tone ?? undefined} aria-label={executor.name}>
      <div className={styles.head}>
        <span className={styles.iconTile}>
          <Icon name={typeIcon(executor.typeId, 'executor')} />
        </span>
        <span className={styles.titles}>
          <Link to={`/executors/${executor.id}`} className={styles.name}>
            {executor.name}
          </Link>
          <span className={styles.meta}>
            <span className="mono">{executor.typeId}</span> · {executor.typeName}
          </span>
        </span>
        <span className={styles.above}>
          <Toggle
            size="sm"
            ariaLabel={`${executor.name} enabled`}
            checked={executor.enabled}
            requires="operator"
            onChange={(next) => void enable.run({ id: executor.id, enabled: next })}
          />
        </span>
      </div>

      <div className={styles.statusLine}>
        <StatusChip tone={executor.status.tone} label={executor.status.label} size="sm" />
        {executor.softHoldUntil && (
          <StatusChip
            tone="warn"
            size="sm"
            label="soft hold"
            title={executor.softHoldReason ?? undefined}
          />
        )}
        {executor.softHoldUntil && (
          <Countdown until={executor.softHoldUntil} prefix="lifts in" className={styles.muted} />
        )}
        {!executor.pluginAvailable && (
          <StatusChip tone="warn" size="sm" label="plugin unavailable" />
        )}
      </div>

      {executor.meters.length > 0 ? (
        <div className={styles.meters} role="list" aria-label={`${executor.name} meters`}>
          {executor.meters.map((m) => (
            <span role="listitem" key={m.meterId}>
              <MeterGauge meter={m} size="md" />
            </span>
          ))}
        </div>
      ) : (
        <span className={styles.noMeters}>
          No meters · capacity is the endpoint&apos;s; only run caps gate.
        </span>
      )}

      <div className={styles.footer}>
        <span>
          <span className="mono">{executor.processCount}</span> process
          {executor.processCount === 1 ? '' : 'es'}
        </span>
        <span>·</span>
        <span>
          <span className="mono">{executor.runs24h}</span> runs · 24 h
        </span>
        {executor.health?.status === 'unhealthy' && executor.health.message && (
          <span className={styles.errNote}>{executor.health.message}</span>
        )}
      </div>
    </article>
  );
}
