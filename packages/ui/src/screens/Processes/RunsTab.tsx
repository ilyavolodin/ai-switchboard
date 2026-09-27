import type { RunSummary } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { errorMessage } from '../../api/client.js';
import { useRun, useRuns } from '../../api/index.js';
import { ArtifactChip } from '../../components/ArtifactChip.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import { Drawer } from '../../components/Drawer.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { LoadMore } from '../../components/LoadMore.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Table, type TableColumn } from '../../components/Table.js';
import { Time } from '../../components/Time.js';
import { traceHref } from '../../lib/artifact.js';
import { formatAmount, formatSeconds } from '../../lib/format.js';
import { runStatusTone } from '../../lib/tone.js';
import styles from './ProcessDetail.module.css';

function ExternalLink({ run }: { run: RunSummary }) {
  if (!run.externalUrl) return <span className="t-caption">—</span>;
  return (
    <a
      href={run.externalUrl}
      target="_blank"
      rel="noreferrer"
      className={styles.external}
      aria-label={`Open run ${run.id} in ${run.executorName} (new tab)`}
    >
      {run.externalId ?? 'open'} ↗
    </a>
  );
}

function RunDrawerBody({ runId }: { runId: string }) {
  const run = useRun(runId);
  if (run.isPending) return <Skeleton lines={8} label="Loading the run" />;
  if (run.isError) {
    return (
      <Banner tone="error" title="Could not load the run">
        {errorMessage(run.error)}
      </Banner>
    );
  }
  const r = run.data;
  return (
    <div className={styles.drawerBody}>
      <div className={styles.row}>
        <StatusChip tone={r.statusLabel.tone} label={r.statusLabel.label} />
        {r.dryRun && <StatusChip tone="off" label="dry run" size="sm" />}
        {r.statusReason && <span className="t-caption">{r.statusReason}</span>}
      </div>
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
          ['executor', r.executorName],
          ['invoked', <Time key="inv" value={r.invokedAt} format="clock-seconds" />],
          ['finished', <Time key="fin" value={r.finishedAt} format="clock-seconds" />],
          ['duration', r.durationSeconds != null ? formatSeconds(r.durationSeconds) : '—'],
          [
            'batch',
            <span key="b" className="mono">
              {r.batchId}
            </span>,
          ],
          ['binding limit', r.bindingLimit ?? '—'],
          ['external', <ExternalLink key="ext" run={r} />],
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
                <StatusChip
                  tone={s.status === 'ok' ? 'ok' : s.error ? 'error' : 'off'}
                  label={s.status}
                  size="sm"
                />
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

/** The process's runs as a table; a row's Details opens its steps, updates and input. */
export function RunsTab({ processId }: { processId: string }) {
  const runs = useRuns({ process: processId });
  const [open, setOpen] = useState<string | null>(null);
  const rows = runs.data?.pages.flatMap((p) => p.items) ?? [];

  const columns: TableColumn<RunSummary>[] = [
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <StatusChip tone={r.statusLabel.tone} label={r.statusLabel.label} size="sm" />,
    },
    { key: 'kind', header: 'Kind', cell: (r) => (r.dryRun ? `${r.kind} · dry run` : r.kind) },
    { key: 'invoked', header: 'Invoked', cell: (r) => <Time value={r.invokedAt} /> },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      mono: true,
      cell: (r) => (r.durationSeconds != null ? formatSeconds(r.durationSeconds) : '—'),
    },
    {
      key: 'artifacts',
      header: 'Artifacts',
      cell: (r) => (
        <span className={styles.row}>
          {r.artifacts.slice(0, 3).map((a) => (
            <ArtifactChip key={`${a.kind}:${a.id}`} artifact={a} showIcon={false} />
          ))}
        </span>
      ),
    },
    {
      key: 'usage',
      header: 'Usage',
      cell: (r) => {
        const first = r.usage ? Object.entries(r.usage)[0] : undefined;
        return first ? (
          <span className="t-caption">
            <span className="mono">{formatAmount(first[1])}</span> {first[0]}
          </span>
        ) : (
          '—'
        );
      },
    },
    { key: 'external', header: 'Executor', cell: (r) => <ExternalLink run={r} /> },
    {
      key: 'details',
      header: <span className="visually-hidden">Details</span>,
      align: 'right',
      cell: (r) => (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Details for run ${r.id}`}
          onClick={() => {
            setOpen(r.id);
          }}
        >
          Details
        </Button>
      ),
    },
  ];

  if (runs.isPending) return <Skeleton lines={6} height={32} label="Loading runs" />;
  if (runs.isError) {
    return (
      <Banner tone="error" title="Could not load runs">
        {errorMessage(runs.error)}
      </Banner>
    );
  }
  return (
    <Card padding="flush">
      <Table
        caption="Runs of this process"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        empty="No runs yet. Run now or wait for a trigger."
      />
      <LoadMore
        hasMore={runs.hasNextPage}
        loading={runs.isFetchingNextPage}
        onLoadMore={() => {
          void runs.fetchNextPage();
        }}
        label="Load more runs"
      />
      <Drawer
        open={open != null}
        onClose={() => {
          setOpen(null);
        }}
        title={open ? `Run ${open}` : 'Run'}
        width={520}
      >
        {open && <RunDrawerBody runId={open} />}
      </Drawer>
    </Card>
  );
}
