import type { ApprovalHistoryItem, ApprovalItem } from '@ai-switchboard/core/contract';
import { Link } from 'react-router';

import {
  useApprovalHistory,
  useApprovalRules,
  useApprovals,
  useApprove,
  useReject,
} from '../../api/index.js';
import { ArtifactChips } from '../../components/ArtifactChips.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LoadMore } from '../../components/LoadMore.js';
import { PageHeader } from '../../components/PageHeader.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Table, type TableColumn } from '../../components/Table.js';
import { Time } from '../../components/Time.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { useFlatPages } from '../../hooks/useFlatPages.js';
import { processHref } from '../../lib/hrefs.js';
import { approvePrompt, rejectPrompt } from '../shared/actionPrompts.js';
import styles from './Approvals.module.css';
import { batchSummary, decisionChip, ruleText } from './approvalCopy.js';

export function Approvals() {
  const pending = useApprovals();
  const rules = useApprovalRules();

  const nameOf = (batchId: string) =>
    pending.data?.find((i) => i.batchId === batchId)?.process.name;
  const approve = useReasonedMutation(useApprove(), (v) => approvePrompt(nameOf(v.batchId)), {
    successMessage: 'Approved — the batch re-entered the gate',
  });
  const reject = useReasonedMutation(useReject(), (v) => rejectPrompt(nameOf(v.batchId)), {
    successMessage: 'Rejected',
  });

  const items = pending.data ?? [];
  const ruleList = rules.data?.processes ?? [];

  return (
    <>
      <PageHeader
        title="Approvals"
        meta={
          pending.data && (
            <StatusChip
              tone={items.length > 0 ? 'warn' : 'off'}
              label={items.length > 0 ? `${items.length} waiting` : 'nothing waiting'}
            />
          )
        }
        actions={
          ruleList.length > 0 && (
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
          )
        }
      />

      <QueryBoundary
        query={pending}
        errorTitle="Approvals could not load"
        pending={
          <div className={styles.grid}>
            <Skeleton shape="card" height={180} label="Loading approvals" />
            <Skeleton shape="card" height={180} />
          </div>
        }
        empty={
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
                        <Link to={processHref(r.id)}>{r.name}</Link>
                        <span className={styles.rule}>approval: {r.rule}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </EmptyState>
          </Card>
        }
      >
        {(list) => (
          <ul className={styles.grid} aria-label="Batches waiting">
            {list.map((item) => (
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
      </QueryBoundary>

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
        <Link className={styles.process} to={processHref(item.process.id)}>
          {item.process.name}
        </Link>
        <StatusChip size="sm" tone="warn" label="awaiting approval" />
        <span className={styles.spacer} />
        <span className={styles.waited}>
          asked <Time value={item.requestedAt} />
        </span>
      </div>
      <div className={styles.chips}>
        <ArtifactChips artifacts={item.artifacts} trace />
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
        <ArtifactChips artifacts={r.artifacts} trace />
      </span>
    ),
  },
  {
    key: 'decision',
    header: 'decision',
    cell: (r) => <StatusChip size="sm" {...decisionChip(r.decision)} />,
  },
  { key: 'by', header: 'by', cell: (r) => r.decidedBy },
  { key: 'when', header: 'when', cell: (r) => <Time value={r.decidedAt} format="when" /> },
  { key: 'reason', header: 'reason', cell: (r) => <span className="t-caption">{r.reason}</span> },
];

function History() {
  const history = useApprovalHistory();
  const rows = useFlatPages(history);
  return (
    <Card title="Recent decisions" subtitle="who approved or rejected what, and why">
      <QueryBoundary
        query={history}
        errorTitle="Decisions could not load"
        pending={<Skeleton lines={3} height={20} label="Loading decisions" />}
      >
        {() => (
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
      </QueryBoundary>
    </Card>
  );
}
