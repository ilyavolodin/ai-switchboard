import type { TraceResponse } from '@ai-switchboard/core/contract';
import { Link, useParams } from 'react-router';

import { isApiRequestError } from '../../api/client.js';
import { useTrace } from '../../api/index.js';
import { ArtifactChips } from '../../components/ArtifactChips.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { PageHeader } from '../../components/PageHeader.js';
import { QueryError } from '../../components/QueryError.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StageIndicator } from '../../components/StageIndicator.js';
import { StatusChip } from '../../components/StatusChip.js';
import { TraceSearchForm } from '../../components/TraceSearchForm.js';
import { TraceTimeline } from '../../components/TraceTimeline.js';
import { WhyNothingRan } from '../../components/WhyNothingRan.js';
import { plural } from '../../lib/format.js';
import { processHref, traceHref } from '../../lib/hrefs.js';
import { whyFromTrace, whyTitle } from '../../lib/why.js';
import {
  EXPANDED_KINDS,
  QUERY_FORMS,
  summarizeTrace,
  TOUCH_WORD,
  traceStage,
} from './traceSummary.js';
import styles from './Trace.module.css';

export function Trace() {
  const { query = '' } = useParams();
  const trace = useTrace(query || undefined);

  const notFound =
    (trace.isError && isApiRequestError(trace.error) && trace.error.status === 404) ||
    trace.data?.entries.length === 0;

  return (
    <>
      <PageHeader
        title={<span className="mono">{query}</span>}
        back={{ to: '/activity', label: 'Back to Activity' }}
        meta={trace.data && <ArtifactChips artifacts={trace.data.artifacts} />}
        actions={
          <TraceSearchForm
            className={styles.search}
            placeholder="artifact id"
            defaultValue={query}
          />
        }
      />

      {trace.isPending ? (
        <Card>
          <Skeleton lines={8} height={18} label="Loading the trace" />
        </Card>
      ) : notFound ? (
        <Card>
          <EmptyState title={`Nothing found for “${query}”`}>
            <p className={styles.teach}>
              The trace looks up events by the artifact they are about. Try one of these forms:
            </p>
            <ul className={styles.forms}>
              {QUERY_FORMS.map((f) => (
                <li key={f.example}>
                  <Link className="mono" to={traceHref(f.example)}>
                    {f.example}
                  </Link>{' '}
                  — {f.help}
                </li>
              ))}
            </ul>
            <p className={styles.teach}>
              Events older than the retention window are removed, so an old artifact may have no
              trace left.
            </p>
          </EmptyState>
        </Card>
      ) : trace.isError ? (
        <QueryError query={trace} title="The trace could not load" />
      ) : (
        <TraceBody data={trace.data} />
      )}
    </>
  );
}

function TraceBody({ data }: { data: TraceResponse }) {
  const summary = summarizeTrace(data.entries);
  const stage = traceStage(data.entries);
  const why = whyFromTrace(data.entries);
  const title = whyTitle(summary.processes.length);
  return (
    <div className={styles.grid}>
      <Card
        title="Timeline"
        subtitle={[
          plural(summary.events, 'event'),
          plural(summary.processes.length, 'process', 'processes'),
          plural(summary.runs, 'run'),
          summary.runs > 0 ? `${summary.ok} ok, ${summary.errors} error` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        <TraceTimeline
          key={data.query}
          entries={data.entries}
          text={data.text}
          expandKinds={EXPANDED_KINDS}
        />
      </Card>
      <div className={styles.side}>
        <Card title="Where it stands" aria-label="Where it stands">
          <StageIndicator indicator={stage} />
        </Card>
        {why.length > 0 && (
          <Card title={title} aria-label={title}>
            <WhyNothingRan items={why} label={title} />
          </Card>
        )}
        <Card title="Processes that touched it" aria-label="Processes that touched it">
          {summary.processes.length === 0 ? (
            <span className="t-caption">No process matched it.</span>
          ) : (
            <ul className={styles.touched}>
              {summary.processes.map((p) => (
                <li key={p.id}>
                  <Link to={processHref(p.id)}>{p.name}</Link>
                  <StatusChip size="sm" tone={p.tone} label={TOUCH_WORD[p.tone]} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
