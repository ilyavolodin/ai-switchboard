import type { TraceEntry, TraceEntryKind } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { Link } from 'react-router';

import { useToast } from '../hooks/toast.js';
import { formatAbsolute, formatClock, toMs } from '../lib/format.js';
import { toneVars } from '../lib/tone.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { KeyValueList } from './KeyValueList.js';
import { StatusChip } from './StatusChip.js';
import styles from './TraceTimeline.module.css';

export interface TraceTimelineProps {
  entries: TraceEntry[];
  /** The server's plain-text rendering for "Copy as text"; generated from entries if absent. */
  text?: string;
  hideCopy?: boolean;
  /** Entries of these kinds start with their details open. */
  expandKinds?: readonly TraceEntryKind[];
}

const TONE_WORD = { ok: 'passed', warn: 'stopped', error: 'failed', off: 'info' } as const;

function toText(entries: TraceEntry[]): string {
  return entries
    .map((e) => {
      const t = formatClock(toMs(e.at) ?? 0, true);
      return `${t}  ${e.title}${e.detail ? ` · ${e.detail}` : ''}${e.externalUrl ? ` · ${e.externalUrl}` : ''}`;
    })
    .join('\n');
}

export function TraceTimeline({ entries, text, hideCopy, expandKinds }: TraceTimelineProps) {
  const [open, setOpen] = useState<Set<number>>(
    () =>
      new Set(
        expandKinds
          ? entries.flatMap((e, i) => (expandKinds.includes(e.kind) && e.data ? [i] : []))
          : [],
      ),
  );
  const toast = useToast();
  const toggle = (i: number) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  return (
    <div className={styles.timeline}>
      {!hideCopy && (
        <div className={styles.toolbar}>
          <Button
            size="sm"
            variant="outline"
            icon="copy"
            onClick={() => {
              void navigator.clipboard.writeText(text ?? toText(entries)).then(() => {
                toast({ tone: 'ok', title: 'Timeline copied' });
              });
            }}
          >
            Copy as text
          </Button>
        </div>
      )}
      <ol className={styles.list} aria-label="Trace timeline">
        {entries.map((e, i) => {
          const ms = toMs(e.at) ?? 0;
          const last = i === entries.length - 1;
          const expanded = open.has(i);
          return (
            <li key={`${e.at}-${i}`} className={styles.item}>
              <time className={styles.time} dateTime={e.at} title={formatAbsolute(ms)}>
                {formatClock(ms, true)}
              </time>
              <span className={styles.rail} aria-hidden="true">
                <span
                  className={styles.dot}
                  style={{
                    background: e.tone === 'off' ? 'var(--border-4)' : toneVars(e.tone).fill,
                  }}
                />
                {!last && <span className={styles.line} />}
              </span>
              <div className={styles.body}>
                <span className="visually-hidden">{TONE_WORD[e.tone]}: </span>
                <span className={styles.title}>{e.title}</span>
                {e.processName && e.processId && (
                  <>
                    {' · '}
                    <Link to={`/processes/${encodeURIComponent(e.processId)}`}>
                      {e.processName}
                    </Link>
                  </>
                )}
                {e.detail && <div className={styles.detail}>{e.detail}</div>}
                <div className={styles.meta}>
                  <span className={styles.kind}>{e.kind.replace('_', ' ')}</span>
                  {e.tone === 'error' && <StatusChip tone="error" size="sm" label="failed" />}
                  {e.tone === 'warn' && <StatusChip tone="warn" size="sm" label="stopped" />}
                  {e.runId && <span className="mono">{e.runId}</span>}
                  {e.externalUrl && (
                    <a
                      className={styles.external}
                      href={e.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      open <Icon name="external" size={11} />
                    </a>
                  )}
                  {e.data && Object.keys(e.data).length > 0 && (
                    <button
                      type="button"
                      className={styles.toggle}
                      aria-expanded={expanded}
                      onClick={() => {
                        toggle(i);
                      }}
                    >
                      {expanded ? 'hide details' : 'details'}
                    </button>
                  )}
                </div>
                {expanded && e.data && (
                  <div className={styles.data}>
                    <KeyValueList data={e.data} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
