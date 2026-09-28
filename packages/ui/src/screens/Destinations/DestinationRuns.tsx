import type { DestinationDetail, RunSummary } from '@ai-switchboard/core/contract';
import { Link } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useRuns } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Card } from '../../components/Card.js';
import { Icon } from '../../components/Icon.js';
import { LoadMore } from '../../components/LoadMore.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Table, type TableColumn } from '../../components/Table.js';
import { Time } from '../../components/Time.js';
import { formatSeconds, formatUsage } from '../../lib/format.js';

/** The destination's Runs tab: every run on it, newest first, with external links (new tab). */
export function DestinationRuns({ destination }: { destination: DestinationDetail }) {
  const runs = useRuns({ destination: destination.id });
  const rows = runs.data?.pages.flatMap((p) => p.items) ?? [];
  const units = new Map(destination.usage.map((u) => [u.id, u.unit]));

  const columns: TableColumn<RunSummary>[] = [
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <StatusChip
          size="sm"
          tone={r.statusLabel.tone}
          label={r.dryRun ? `${r.statusLabel.label} · dry run` : r.statusLabel.label}
          title={r.statusReason ?? undefined}
        />
      ),
    },
    {
      key: 'process',
      header: 'Process',
      cell: (r) => <Link to={`/processes/${r.processId}`}>{r.processName}</Link>,
    },
    { key: 'kind', header: 'Kind', cell: (r) => r.kind },
    { key: 'invoked', header: 'Invoked', cell: (r) => <Time value={r.invokedAt} /> },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      mono: true,
      cell: (r) => (r.durationSeconds != null ? formatSeconds(r.durationSeconds) : '—'),
    },
    { key: 'events', header: 'Events', align: 'right', mono: true, cell: (r) => r.eventCount },
    {
      key: 'usage',
      header: 'Usage',
      cell: (r) =>
        r.usage
          ? Object.entries(r.usage)
              .map(([k, v]) => formatUsage(v, units.get(k) ?? k))
              .join(' · ')
          : '—',
    },
    {
      key: 'external',
      header: 'External',
      cell: (r) =>
        r.externalUrl ? (
          <a href={r.externalUrl} target="_blank" rel="noreferrer" className="mono">
            {r.externalId ?? 'open'} <Icon name="external" size={11} />
          </a>
        ) : (
          <span className="mono">{r.externalId ?? '—'}</span>
        ),
    },
  ];

  return (
    <Card padding="flush">
      {runs.isPending ? (
        <Skeleton lines={6} height={28} label="Loading runs" />
      ) : runs.isError ? (
        <Banner tone="error" title="Runs could not load">
          {errorMessage(runs.error)}
        </Banner>
      ) : (
        <Table
          caption={`Runs on ${destination.name}`}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty="No runs on this destination yet."
        />
      )}
      <LoadMore
        hasMore={runs.hasNextPage}
        loading={runs.isFetchingNextPage}
        onLoadMore={() => void runs.fetchNextPage()}
        label="Load more runs"
      />
    </Card>
  );
}
