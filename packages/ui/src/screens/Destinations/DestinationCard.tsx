import type { DestinationSummary } from '@ai-switchboard/core/contract';

import { Countdown } from '../../components/Countdown.js';
import { MeterGauge } from '../../components/MeterGauge.js';
import { StatusChip } from '../../components/StatusChip.js';
import { pluralWord } from '../../lib/format.js';
import { destinationHref } from '../../lib/hrefs.js';
import { cardTone } from '../../lib/instances.js';
import { InstanceCardHeader } from '../shared/InstanceCardHeader.js';
import styles from '../shared/instanceCard.module.css';
import { useDestinationActions } from './useDestinationActions.js';

export function DestinationCard({ destination }: { destination: DestinationSummary }) {
  const actions = useDestinationActions(destination);
  const tone = cardTone(destination.enabled, destination.status.tone);
  return (
    <article className={styles.card} data-tone={tone ?? undefined} aria-label={destination.name}>
      <InstanceCardHeader
        kind="destination"
        name={destination.name}
        icon={destination.typeIcon}
        href={destinationHref(destination.id)}
        meta={
          <>
            <span className="mono">{destination.typeId}</span> · {destination.typeName}
          </>
        }
        enabled={destination.enabled}
        onEnabledChange={actions.setEnabled}
      />

      <div className={styles.statusLine}>
        <StatusChip tone={destination.status.tone} label={destination.status.label} size="sm" />
        {destination.softHoldUntil && (
          <StatusChip
            tone="warn"
            size="sm"
            label="soft hold"
            title={destination.softHoldReason ?? undefined}
          />
        )}
        {destination.softHoldUntil && (
          <Countdown until={destination.softHoldUntil} prefix="lifts in" className={styles.muted} />
        )}
        {!destination.pluginAvailable && (
          <StatusChip tone="warn" size="sm" label="plugin unavailable" />
        )}
      </div>

      {destination.meters.length > 0 ? (
        <div className={styles.meters} role="list" aria-label={`${destination.name} meters`}>
          {destination.meters.map((m) => (
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
          <span className="mono">{destination.processCount}</span>{' '}
          {pluralWord(destination.processCount, 'process', 'processes')}
        </span>
        <span>·</span>
        <span>
          <span className="mono">{destination.runs24h}</span> runs · 24 h
        </span>
        {destination.health?.status === 'unhealthy' && destination.health.message && (
          <span className={styles.errNote}>{destination.health.message}</span>
        )}
      </div>
    </article>
  );
}
