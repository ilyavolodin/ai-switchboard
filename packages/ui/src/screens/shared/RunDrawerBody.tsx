import type { RunDetail } from '@ai-switchboard/core/contract';
import { SETTLED_RUN_STATUSES } from '@ai-switchboard/core/domain';

import { useCloseRun, useRun } from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { ArtifactChip } from '../../components/ArtifactChip.js';
import { Banner } from '../../components/Banner.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { QueryError } from '../../components/QueryError.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { traceHref } from '../../lib/artifact.js';
import { formatSeconds } from '../../lib/format.js';
import { runStatusTone, stepStatusTone } from '../../lib/tone.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { closeRunPrompt } from './actionPrompts.js';
import { RunExternalLink } from './RunExternalLink.js';
import styles from './RunsTable.module.css';

export function RunDrawerBody({ runId }: { runId: string }) {
  const run = useRun(runId);
  if (run.isPending) return <Skeleton lines={8} label="Loading the run" />;
  if (run.isError) {
    return <QueryError query={run} title="The run could not load" />;
  }
  const r = run.data;
  return (
    <div className={styles.drawerBody}>
      <div className={styles.row}>
        <StatusChip tone={r.statusLabel.tone} label={r.statusLabel.label} />
        {r.dryRun && <StatusChip tone="off" label="dry run" size="sm" />}
        {r.statusReason && <span className="t-caption">{r.statusReason}</span>}
      </div>
      {r.status === 'uncertain' && <SettleRun run={r} />}
      <KeyValueList
        label="Run facts"
        data={[
          [
            'run',
            <span key="id" className="mono">
              {r.id}
            </span>,
          ],
          ['kind', r.kind],
          ['destination', r.destinationName],
          ['invoked', <Time key="inv" value={r.invokedAt} format="clock-seconds" />],
          ['finished', <Time key="fin" value={r.finishedAt} format="clock-seconds" />],
          ['duration', r.durationSeconds != null ? formatSeconds(r.durationSeconds) : '—'],
          [
            'batch',
            <span key="b" className="mono">
              {r.batchId}
            </span>,
          ],
          ...(r.requestedBy
            ? [['requested', `Run now by ${r.requestedBy}`] as [string, string]]
            : []),
          ['external', <RunExternalLink key="ext" run={r} />],
        ]}
      />
      {r.artifacts.length > 0 && (
        <div className={styles.row}>
          {r.artifacts.map((a) => (
            <ArtifactChip key={`${a.kind}:${a.id}`} artifact={a} to={traceHref(a.id)} />
          ))}
        </div>
      )}
      {r.errors.length > 0 && (
        <Banner tone="error" title="Errors">
          <ul className={styles.plainList}>
            {r.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Banner>
      )}
      {r.usage && (
        <section aria-label="Usage">
          <h3 className="t-section-title">Usage</h3>
          <KeyValueList data={r.usage} />
        </section>
      )}
      <section aria-label="Steps">
        <h3 className="t-section-title">Steps</h3>
        {r.steps.length === 0 ? (
          <p className="t-caption">No steps ran.</p>
        ) : (
          <ol className={styles.plainList}>
            {r.steps.map((s) => (
              <li key={`${s.phase}-${s.index}`} className={styles.stepRow}>
                <span className="t-overline">{s.phase}</span>
                <span className="mono">
                  {s.providerId}.{s.action}
                </span>
                <StatusChip {...stepStatusTone(s.status)} size="sm" />
                <Time value={s.at} format="clock-seconds" />
                {s.error && <span className={styles.errorText}>{s.error}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Updates">
        <h3 className="t-section-title">Updates</h3>
        {r.updates.length === 0 ? (
          <p className="t-caption">No tracking updates yet.</p>
        ) : (
          <ol className={styles.plainList}>
            {r.updates.map((u, i) => (
              <li key={i} className={styles.stepRow}>
                <Time value={u.at} format="clock-seconds" />
                <span className="t-caption">{u.source}</span>
                <StatusChip tone={runStatusTone(u.status)} label={u.status} size="sm" />
                {u.detail != null && (
                  <span className="mono t-caption">{JSON.stringify(u.detail)}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Input">
        <h3 className="t-section-title">Input</h3>
        <CodeBlock value={r.input} copyable label="Run input" />
      </section>
      {r.result != null && (
        <section aria-label="Result">
          <h3 className="t-section-title">Result</h3>
          <CodeBlock value={r.result} label="Run result" />
        </section>
      )}
    </div>
  );
}

/** An uncertain run waits for tracking; a person who knows the outcome can settle it. */
function SettleRun({ run }: { run: RunDetail }) {
  const close = useReasonedMutation(useCloseRun(), (v) => closeRunPrompt(v.status), {
    successMessage: (d) => `Run settled as ${d.status}`,
  });
  return (
    <section aria-label="Settle this run" className={styles.settle}>
      <p className="t-caption">
        Switchboard can’t tell whether this run happened: it was never retried, so it won’t run
        twice. If you know the outcome, settle it.
      </p>
      <div className={styles.row}>
        {SETTLED_RUN_STATUSES.map((status) => (
          <Button
            key={status}
            size="sm"
            variant="outline"
            requires="operator"
            loading={close.pending && close.mutation.variables?.status === status}
            onClick={() => void close.run({ id: run.id, status })}
          >
            Mark {status}
          </Button>
        ))}
      </div>
    </section>
  );
}
