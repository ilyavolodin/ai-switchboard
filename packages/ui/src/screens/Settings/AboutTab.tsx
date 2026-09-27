import { errorMessage } from '../../api/client.js';
import { useAbout } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Card } from '../../components/Card.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import styles from './Settings.module.css';

/** About: versions, the database, the public URL and every replica with a live dot. */
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
