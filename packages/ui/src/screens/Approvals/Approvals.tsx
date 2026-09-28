import type { ApprovalHistoryItem, ApprovalItem } from '@ai-switchboard/core/contract';
import { Link } from 'react-router';

import { errorMessage } from '../../api/client.js';
import {
  useApprovalHistory,
  useApprovalRules,
  useApprovals,
  useApprove,
  useReject,
} from '../../api/index.js';
import { ArtifactChip } from '../../components/ArtifactChip.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LoadMore } from '../../components/LoadMore.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Table, type TableColumn } from '../../components/Table.js';
import { Time } from '../../components/Time.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { traceHref } from '../../lib/artifact.js';
import styles from './Approvals.module.css';
import { batchSummary, ruleText } from './approvalCopy.js';

/**
 * Approvals: the queue of batches a gate is holding for a person. Each card shows the process,
 * the events as artifact chips, the rule, how long it has waited and the input that would be
 * sent; Approve / Reject ask for a reason. Readable on a phone (one column, 44 px targets).
 */
export function Approvals() {
  const pending = useApprovals();
  const rules = useApprovalRules();

  const nameOf = (batchId: string) =>
    pending.data?.find((i) => i.batchId === batchId)?.process.name ?? 'this';
  const approve = useReasonedMutation(
    useApprove(),
    (v) => ({
      title: `Approve the ${nameOf(v.batchId)} batch?`,
      consequence: 'The batch re-enters the gate and runs if its budget allows.',
      confirmLabel: 'Approve',
    }),
    { successMessage: 'Approved — the batch re-entered the gate' },
  );
  const reject = useReasonedMutation(
    useReject(),
    (v) => ({
      title: `Reject the ${nameOf(v.batchId)} batch?`,
      consequence: 'The batch is dropped and never runs. Its events stay in Activity.',
      confirmLabel: 'Reject',
      danger: true,
    }),
    { successMessage: 'Rejected' },
  );

  const items = pending.data ?? [];
  const ruleList = rules.data?.processes ?? [];

  return (
    <>
      <div className={styles.header}>
        <h1 className="t-screen-title">Approvals</h1>
        {pending.data && (
          <StatusChip
            tone={items.length > 0 ? 'warn' : 'off'}
            label={items.length > 0 ? `${items.length} waiting` : 'nothing waiting'}
          />
        )}
        <span className={styles.spacer} />
        {ruleList.length > 0 && (
          <span className="t-caption">
            Processes with approval rules:{' '}
            {ruleList.map((r, i) => (
              <span key={r.id}>
                {i > 0 && ', '}
                {r.name} ({ruleText(r.rule)})
              </span>
            ))}
            . Approving a batch re-enters it at the gate.
          </span>
        )}
      </div>

      {pending.isPending ? (
        <div className={styles.grid}>
          <Skeleton shape="card" height={180} label="Loading approvals" />
          <Skeleton shape="card" height={180} />
        </div>
      ) : pending.isError ? (
        <Banner
          tone="error"
          title="Approvals could not load"
          actions={
            <Button size="sm" variant="outline" onClick={() => void pending.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(pending.error)}
        </Banner>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState title="Nothing is waiting for approval">
            {rules.isPending ? null : ruleList.length === 0 ? (
              <p className={styles.emptyText}>
                No process has an approval rule. Add one in a process’s Gates section (approval:
                always, or an expression over the batch) and its batches will wait here.
              </p>
            ) : (
              <>
                <p className={styles.emptyText}>
                  Batches from these processes wait here before they run:
                </p>
                <ul className={styles.ruleList} aria-label="Processes with approval rules">
                  {ruleList.map((r) => (
                    <li key={r.id}>
                      <Link to={`/processes/${encodeURIComponent(r.id)}`}>{r.name}</Link>
                      <span className={styles.rule}>approval: {r.rule}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </EmptyState>
        </Card>
      ) : (
        <ul className={styles.grid} aria-label="Batches waiting">
          {items.map((item) => (
            <ApprovalCard
              key={item.batchId}
              item={item}
              busy={approve.pending || reject.pending}
              onApprove={() => void approve.run({ batchId: item.batchId })}
              onReject={() => void reject.run({ batchId: item.batchId })}
            />
          ))}
        </ul>
      )}

      <History />
    </>
  );
}

function ApprovalCard({
  item,
  busy,
  onApprove,
  onReject,
}: {
  item: ApprovalItem;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <li className={styles.card} aria-label={`${item.process.name} batch ${item.batchId}`}>
      <div className={styles.cardHead}>
        <Link className={styles.process} to={`/processes/${encodeURIComponent(item.process.id)}`}>
          {item.process.name}
        </Link>
        <StatusChip size="sm" tone="warn" label="awaiting approval" />
        <span className={styles.spacer} />
        <span className={styles.waited}>
          asked <Time value={item.requestedAt} />
        </span>
      </div>
      <div className={styles.chips}>
        {item.artifacts.map((a) => (
          <ArtifactChip key={`${a.kind}:${a.id}`} artifact={a} to={traceHref(a.id)} />
        ))}
        <span className="t-caption">{batchSummary(item)}</span>
      </div>
      <div className={styles.ruleRow}>
        <span className="t-caption">rule</span>
        <span className={styles.rule}>approval: {item.rule}</span>
      </div>
      <details className={styles.input}>
        <summary>Input that would be sent</summary>
        <CodeBlock value={item.input} copyable label={`Input for ${item.process.name}`} />
      </details>
      <div className={styles.actions}>
        <Button
          variant="outline"
          size="md"
          requires="operator"
          disabled={busy}
          onClick={onReject}
          aria-label={`Reject ${item.process.name} batch ${item.batchId}`}
        >
          Reject
        </Button>
        <Button
          variant="primary"
          size="md"
          requires="operator"
          disabled={busy}
          onClick={onApprove}
          aria-label={`Approve ${item.process.name} batch ${item.batchId}`}
        >
          Approve
        </Button>
      </div>
    </li>
  );
}

const HISTORY_COLUMNS: TableColumn<ApprovalHistoryItem>[] = [
  {
    key: 'process',
    header: 'process',
    cell: (r) => <span className={styles.historyProcess}>{r.process.name}</span>,
  },
  {
    key: 'artifacts',
    header: 'events',
    cell: (r) => (
      <span className={styles.chips}>
        {r.artifacts.map((a) => (
          <ArtifactChip key={`${a.kind}:${a.id}`} artifact={a} to={traceHref(a.id)} />
        ))}
      </span>
    ),
  },
  {
    key: 'decision',
    header: 'decision',
    cell: (r) => (
      <StatusChip
        size="sm"
        tone={r.decision === 'approved' ? 'ok' : r.decision === 'withdrawn' ? 'off' : 'error'}
        label={r.decision === 'withdrawn' ? 'withdrawn · process deleted' : r.decision}
      />
    ),
  },
  { key: 'by', header: 'by', cell: (r) => r.decidedBy },
  { key: 'when', header: 'when', cell: (r) => <Time value={r.decidedAt} format="when" /> },
  { key: 'reason', header: 'reason', cell: (r) => <span className="t-caption">{r.reason}</span> },
];

function History() {
  const history = useApprovalHistory();
  const rows = history.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card title="Recent decisions" subtitle="who approved or rejected what, and why">
      {history.isPending ? (
        <Skeleton lines={3} height={20} label="Loading decisions" />
      ) : history.isError ? (
        <Banner tone="error" title="Decisions could not load">
          {errorMessage(history.error)}
        </Banner>
      ) : (
        <>
          <Table
            caption="Approval decisions"
            columns={HISTORY_COLUMNS}
            rows={rows}
            rowKey={(r) => r.batchId}
            empty="No decisions yet."
          />
          <LoadMore
            hasMore={history.hasNextPage}
            loading={history.isFetchingNextPage}
            onLoadMore={() => void history.fetchNextPage()}
          />
        </>
      )}
    </Card>
  );
}
