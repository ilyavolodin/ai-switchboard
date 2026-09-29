import { type SubmitEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { errorMessage, isApiRequestError } from '../../api/client.js';
import { useTrace } from '../../api/index.js';
import { ArtifactChip } from '../../components/ArtifactChip.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { PageHeader } from '../../components/PageHeader.js';
import { SearchInput } from '../../components/SearchInput.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StageIndicator } from '../../components/StageIndicator.js';
import { StatusChip } from '../../components/StatusChip.js';
import { TraceTimeline } from '../../components/TraceTimeline.js';
import { WhyNothingRan } from '../../components/WhyNothingRan.js';
import { traceHref } from '../../lib/artifact.js';
import { whyFromTrace } from '../../lib/why.js';
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
  const navigate = useNavigate();
  const trace = useTrace(query || undefined);

  const onSearch = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('trace');
    if (typeof q === 'string' && q.trim()) void navigate(traceHref(q.trim()));
  };

  const notFound =
    (trace.isError && isApiRequestError(trace.error) && trace.error.status === 404) ||
    trace.data?.entries.length === 0;

  return (
    <>
      <PageHeader
        title={<span className="mono">{query}</span>}
        back={{ to: '/activity', label: 'Back to Activity' }}
        meta={trace.data?.artifacts.map((a) => (
          <ArtifactChip key={`${a.kind}:${a.id}`} artifact={a} />
        ))}
        actions={
          <form role="search" className={styles.search} onSubmit={onSearch}>
            <SearchInput
              key={query}
              name="trace"
              mono
              label="Trace an artifact"
              placeholder="artifact id"
              defaultValue={query}
            />
          </form>
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
        <Banner
          tone="error"
          title="The trace could not load"
          actions={
            <Button size="sm" variant="outline" onClick={() => void trace.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(trace.error)}
        </Banner>
      ) : (
        <TraceBody data={trace.data} />
      )}
    </>
  );
}

function TraceBody({ data }: { data: NonNullable<ReturnType<typeof useTrace>['data']> }) {
  const summary = summarizeTrace(data.entries);
  const stage = traceStage(data.entries);
  const why = whyFromTrace(data.entries);
  const whyTitle =
    summary.processes.length === 0 ? 'Why nothing ran' : 'Processes that did not take it';
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
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
          <Card title={whyTitle} aria-label={whyTitle}>
            <WhyNothingRan items={why} label={whyTitle} />
          </Card>
        )}
        <Card title="Processes that touched it" aria-label="Processes that touched it">
          {summary.processes.length === 0 ? (
            <span className="t-caption">No process matched it.</span>
          ) : (
            <ul className={styles.touched}>
              {summary.processes.map((p) => (
                <li key={p.id}>
                  <Link to={`/processes/${encodeURIComponent(p.id)}`}>{p.name}</Link>
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
