import type { DestinationSummary } from '@ai-switchboard/core/contract';
import { Link } from 'react-router';

import { useEnableDestination } from '../../api/index.js';
import { Countdown } from '../../components/Countdown.js';
import { TypeIcon } from '../../components/TypeIcon.js';
import { MeterGauge } from '../../components/MeterGauge.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Toggle } from '../../components/Toggle.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { cardTone } from '../../lib/instances.js';
import styles from '../shared/instanceCard.module.css';
import { enableDestinationPrompt } from './destinationModel.js';

export function DestinationCard({ destination }: { destination: DestinationSummary }) {
  const enable = useReasonedMutation(
    useEnableDestination(),
    (v: { id: string; enabled: boolean }) => enableDestinationPrompt(destination, v.enabled),
  );
  const tone = cardTone(destination.enabled, destination.status.tone);
  return (
    <article className={styles.card} data-tone={tone ?? undefined} aria-label={destination.name}>
      <div className={styles.head}>
        <span className={styles.iconTile}>
          <TypeIcon icon={destination.typeIcon} kind="destination" />
        </span>
        <span className={styles.titles}>
          <Link to={`/destinations/${destination.id}`} className={styles.name}>
            {destination.name}
          </Link>
          <span className={styles.meta}>
            <span className="mono">{destination.typeId}</span> · {destination.typeName}
          </span>
        </span>
        <span className={styles.above}>
          <Toggle
            size="sm"
            ariaLabel={`${destination.name} enabled`}
            value={destination.enabled}
            requires="operator"
            onChange={(next) => void enable.run({ id: destination.id, enabled: next })}
          />
        </span>
      </div>

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
          <span className="mono">{destination.processCount}</span> process
          {destination.processCount === 1 ? '' : 'es'}
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
