import { useState } from 'react';

import {
  useProcessVersion,
  useProcessVersions,
  useRestoreProcessVersion,
} from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { QueryError } from '../../components/QueryError.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { cx } from '../../lib/cx.js';
import { changeLabel, documentChanges, formatChangeValue } from './diff.js';
import styles from './ProcessDetail.module.css';

function VersionDiff({
  processId,
  version,
  previous,
}: {
  processId: string;
  version: number;
  previous: number | undefined;
}) {
  const current = useProcessVersion(processId, version);
  const before = useProcessVersion(processId, previous);
  if (current.isPending || (previous != null && before.isPending)) {
    return <Skeleton lines={4} label="Loading the diff" />;
  }
  if (current.isError) {
    return <QueryError query={current} title="The version could not load" />;
  }
  if (previous == null) {
    return <p className="t-caption">The first version: nothing to compare it with.</p>;
  }
  const changes = documentChanges(before.data?.document, current.data.document);
  if (changes.length === 0) {
    return <p className="t-caption">Same document as version {previous}.</p>;
  }
  return (
    <table className={styles.diff}>
      <caption className="visually-hidden">
        Changes from version {previous} to version {version}
      </caption>
      <thead>
        <tr>
          <th scope="col">field</th>
          <th scope="col">version {previous}</th>
          <th scope="col">version {version}</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={JSON.stringify(c.path)}>
            <th scope="row">{changeLabel(c.path)}</th>
            <td className={styles.diffBefore}>{formatChangeValue(c.before)}</td>
            <td className={styles.diffAfter}>{formatChangeValue(c.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HistoryTab({
  processId,
  processName,
  currentVersion,
}: {
  processId: string;
  processName: string;
  currentVersion: number;
}) {
  const versions = useProcessVersions(processId);
  const [selected, setSelected] = useState<number | null>(null);
  const restore = useReasonedMutation(
    useRestoreProcessVersion(),
    (v) => ({
      title: `Restore version ${v.version} of ${processName}?`,
      consequence: `Version ${v.version}'s document is saved as version ${currentVersion + 1}; the current version stays in the history.`,
      confirmLabel: 'Restore',
    }),
    { successMessage: (p) => `${p.name} restored · version ${p.version}` },
  );

  if (versions.isPending) return <Skeleton lines={5} height={40} label="Loading versions" />;
  if (versions.isError) {
    return <QueryError query={versions} title="The history could not load" />;
  }
  const list = [...versions.data].sort((a, b) => b.version - a.version);
  const shown = selected ?? list[0]?.version;
  const index = list.findIndex((v) => v.version === shown);
  const previous = index >= 0 ? list[index + 1]?.version : undefined;

  return (
    <div className={styles.history}>
      <Card padding="flush" title={<span className={styles.padTitle}>Versions</span>}>
        <ol className={styles.versions} aria-label="Versions">
          {list.map((v) => {
            const isCurrent = v.version === currentVersion;
            return (
              <li
                key={v.version}
                className={cx(styles.version, v.version === shown && styles.versionSelected)}
              >
                <button
                  type="button"
                  className={styles.versionButton}
                  aria-pressed={v.version === shown}
                  onClick={() => {
                    setSelected(v.version);
                  }}
                >
                  <span className={styles.versionNumber}>version {v.version}</span>
                  {isCurrent && <StatusChip tone="ok" label="current" size="sm" />}
                  <span className="t-caption">
                    {v.savedBy} · <Time value={v.savedAt} />
                  </span>
                  <span className={styles.versionReason}>“{v.reason}”</span>
                </button>
                {!isCurrent && (
                  <Button
                    size="sm"
                    variant="outline"
                    requires="operator"
                    aria-label={`Restore version ${v.version}`}
                    onClick={() => {
                      void restore.run({ id: processId, version: v.version });
                    }}
                  >
                    Restore
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </Card>
      <Card title={shown != null ? `What changed in version ${shown}` : 'What changed'}>
        {shown != null && <VersionDiff processId={processId} version={shown} previous={previous} />}
      </Card>
    </div>
  );
}
