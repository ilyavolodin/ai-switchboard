import type { AboutResponse } from '@ai-switchboard/core/contract';
import type { ReactNode } from 'react';

import { errorMessage } from '../../api/client.js';
import { useAbout } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Card } from '../../components/Card.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import styles from './Settings.module.css';

type Telemetry = AboutResponse['telemetry'];

/** One signal's destination: "OTLP http/protobuf → http://collector:4318 · 1 header". */
function signalTarget(s: Telemetry['signals'][number]): string {
  const parts: string[] = [];
  if (s.exporters.includes('otlp') && s.endpoint) {
    parts.push(
      `OTLP ${s.protocol ?? ''} → ${s.endpoint}${s.headers > 0 ? ` · ${s.headers} header${s.headers === 1 ? '' : 's'}` : ''}`,
    );
  }
  if (s.exporters.includes('console')) parts.push('console');
  return parts.join(' + ');
}

function TelemetryCard({ telemetry }: { telemetry: Telemetry }) {
  const rows: [string, ReactNode][] = telemetry.signals.map((s) => {
    const on = s.exporters.length > 0;
    return [
      s.signal,
      <span key={s.signal} className={styles.replica}>
        <StatusChip size="sm" tone={on ? 'ok' : 'off'} label={on ? 'exported' : 'not exported'} />
        {on && <span className="mono">{signalTarget(s)}</span>}
      </span>,
    ];
  });
  rows.push([
    'prometheus',
    <StatusChip
      key="prom"
      size="sm"
      tone={telemetry.prometheus ? 'ok' : 'off'}
      label={telemetry.prometheus ? 'served at /metrics' : 'off'}
    />,
  ]);
  rows.push([
    'service',
    <span key="svc" className="mono">
      {telemetry.serviceName}
    </span>,
  ]);
  rows.push([
    'sampler',
    <span key="smp" className="mono">
      {telemetry.sampler}
    </span>,
  ]);
  return (
    <Card title="Telemetry" subtitle="OpenTelemetry export from this replica (OTEL_* variables)">
      {telemetry.enabled ? (
        <KeyValueList label="Telemetry" data={rows} />
      ) : (
        <Banner tone="info" title="OpenTelemetry is off">
          OTEL_SDK_DISABLED is set: no traces, metrics or logs are exported and /metrics is not
          served.
        </Banner>
      )}
    </Card>
  );
}

/** About: versions, the database, the public URL, telemetry and every replica with a live dot. */
export function AboutTab() {
  const about = useAbout();
  if (about.isPending) return <Skeleton shape="card" height={240} label="Loading about" />;
  if (about.isError) {
    return (
      <Banner tone="error" title="About could not load">
        {errorMessage(about.error)}
      </Banner>
    );
  }
  const a = about.data;
  return (
    <div className={styles.grid}>
      <Card title="AI Switchboard" subtitle="open-source event dispatcher">
        <KeyValueList
          label="Installation"
          data={[
            ['version', `switchboard ${a.version} · sdk ${a.sdkVersion}`],
            [
              'database',
              <StatusChip
                key="db"
                size="sm"
                tone={a.database.ok ? 'ok' : 'error'}
                label={`${a.database.ok ? 'ok' : 'unreachable'}${a.database.version ? ` · postgres ${a.database.version}` : ''}`}
                title={a.database.version ? `postgres ${a.database.version}` : undefined}
              />,
            ],
            ['plugins', String(a.plugins)],
            [
              'public URL',
              <a key="url" href={a.publicUrl} target="_blank" rel="noreferrer">
                {a.publicUrl}
              </a>,
            ],
            ['mode', a.evaluation ? 'evaluation (local sign-in)' : 'production'],
          ]}
        />
      </Card>
      <TelemetryCard telemetry={a.telemetry} />
      <Card title="Replicas" subtitle="every core process sharing this database">
        <ul className={styles.replicas} aria-label="Replicas">
          {a.replicas.map((r) => (
            <li key={r.id} className={styles.replica}>
              <StatusChip size="sm" tone={r.live ? 'ok' : 'off'} label={r.live ? 'live' : 'gone'} />
              <span className="mono">{r.hostname}</span>
              <span className="t-caption">
                {r.version} · started <Time value={r.startedAt} /> · heartbeat{' '}
                <Time value={r.heartbeatAt} />
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
