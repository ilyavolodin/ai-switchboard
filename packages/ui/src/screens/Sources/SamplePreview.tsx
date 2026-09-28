import type { SourcePreviewResponse } from '@ai-switchboard/core/contract';
import { errorMessage } from '../../api/client.js';
import { useLastDelivery, usePreviewSource } from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { ArtifactChip } from '../../components/ArtifactChip.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Textarea } from '../../components/Textarea.js';
import { TextField } from '../../components/TextField.js';
import { useDebounced } from '../../hooks/useDebounced.js';
import {
  draftFromDelivery,
  EMPTY_SAMPLE,
  previewRequest,
  type SampleDraft,
} from '../../lib/sampleDelivery.js';
import styles from './SamplePreview.module.css';

export interface SamplePreviewProps {
  typeId: string;
  /** The draft settings as they are in the form right now. */
  settings: Record<string, unknown>;
  /** The existing source (Settings tab): enables "Use the last delivery". */
  sourceId?: string;
  sample: SampleDraft;
  onSampleChange: (next: SampleDraft) => void;
}

const EXAMPLE = '{\n  "id": "dep_48213",\n  "service": "api",\n  "status": "success"\n}';

/**
 * "Try it with a sample delivery": paste what the sender would send (or take the source's last
 * delivery) and see the events it becomes — type, artifact, attributes — or why it becomes none,
 * updating as the settings change. Runs `POST /sources/preview`: nothing is stored.
 */
export function SamplePreview({
  typeId,
  settings,
  sourceId,
  sample,
  onSampleChange,
}: SamplePreviewProps) {
  const canPreview = useCan('operator');
  const last = useLastDelivery(sourceId);
  const request = useDebounced(
    canPreview ? previewRequest(typeId, settings, sourceId, sample) : null,
    400,
  );
  const preview = usePreviewSource(request);
  const put = (patch: Partial<SampleDraft>) => {
    onSampleChange({ ...sample, ...patch });
  };

  return (
    <section className={styles.panel} aria-label="Try it with a sample delivery">
      <div className={styles.head}>
        <h3 className="t-section-title">Try it with a sample delivery</h3>
        <p className="t-caption">
          Paste a body the sender would send and see the events it becomes, updating as you change
          the settings. The signature is not checked and nothing is stored. Path fields suggest what
          is in the sample.
        </p>
      </div>
      <Field label="Sample body" help="JSON, as the sender posts it.">
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            mono
            rows={8}
            spellCheck={false}
            placeholder={EXAMPLE}
            disabled={!canPreview}
            value={sample.body}
            onChange={(e) => {
              put({ body: e.target.value });
            }}
          />
        )}
      </Field>
      <details className={styles.more}>
        <summary>Headers and query string</summary>
        <div className={styles.moreFields}>
          <Field label="Sample headers" help="One per line, e.g. x-event-type: issue.created">
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                mono
                rows={3}
                spellCheck={false}
                disabled={!canPreview}
                value={sample.headers}
                onChange={(e) => {
                  put({ headers: e.target.value });
                }}
              />
            )}
          </Field>
          <Field label="Sample query string" help="e.g. env=staging">
            {({ id, describedBy }) => (
              <TextField
                id={id}
                aria-describedby={describedBy}
                mono
                disabled={!canPreview}
                value={sample.query}
                onChange={(e) => {
                  put({ query: e.target.value });
                }}
              />
            )}
          </Field>
        </div>
      </details>
      <div className={styles.actions}>
        {sourceId && (
          <Button
            size="sm"
            variant="outline"
            requires="operator"
            loading={last.isFetching}
            onClick={() => {
              void last.refetch().then((r) => {
                if (r.data) onSampleChange(draftFromDelivery(r.data));
              });
            }}
          >
            Use the last delivery
          </Button>
        )}
        {sample !== EMPTY_SAMPLE && sample.body !== '' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onSampleChange(EMPTY_SAMPLE);
            }}
          >
            Clear sample
          </Button>
        )}
      </div>
      {last.isError && <Banner tone="neutral">{errorMessage(last.error)}</Banner>}
      {!canPreview ? (
        <p className="t-caption">Trying a sample needs the operator role.</p>
      ) : (
        <PreviewResult
          empty={request === null}
          loading={preview.isFetching && !preview.data}
          error={preview.isError ? errorMessage(preview.error) : null}
          data={request === null ? undefined : preview.data}
        />
      )}
    </section>
  );
}

function PreviewResult({
  empty,
  loading,
  error,
  data,
}: {
  empty: boolean;
  loading: boolean;
  error: string | null;
  data: SourcePreviewResponse | undefined;
}) {
  if (empty) return null;
  return (
    <div className={styles.result} role="region" aria-label="Preview result" aria-live="polite">
      {loading && <p className="t-caption">Trying the sample…</p>}
      {error && (
        <Banner tone="error" title="The preview failed">
          {error}
        </Banner>
      )}
      {data && data.errors.length > 0 && (
        <Banner tone="error" title="Problems with this sample">
          <ul className={styles.list}>
            {data.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Banner>
      )}
      {data?.events.length === 0 && data.errors.length === 0 && (
        <Banner tone="warn" title="No events">
          This delivery would be accepted but would produce no event.
        </Banner>
      )}
      {data && data.notes.length > 0 && (
        <Banner tone="info" title="Why">
          <ul className={styles.list}>
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Banner>
      )}
      {data && data.events.length > 0 && (
        <ol className={styles.events} aria-label="Resulting events">
          {data.events.map((ev, i) => (
            <li key={`${ev.dedupeKey}-${String(i)}`} className={styles.event}>
              <div className={styles.eventHead}>
                <StatusChip
                  tone={ev.valid ? 'ok' : 'error'}
                  label={ev.valid ? 'valid' : 'invalid'}
                  size="sm"
                />
                <span className="mono">{ev.type}</span>
                <ArtifactChip artifact={ev.artifact} showIcon={false} />
              </div>
              {Object.keys(ev.attributes).length > 0 ? (
                <KeyValueList data={ev.attributes} label={`Attributes of event ${String(i + 1)}`} />
              ) : (
                <p className="t-caption">No attributes.</p>
              )}
              <p className={`${styles.key} mono`}>dedupe key {ev.dedupeKey}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
