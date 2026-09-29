import type { FilterPreviewResponse } from '@ai-switchboard/core/contract';
import { type ReactNode, useRef, useState } from 'react';

import { useSuggestions } from '../hooks/useSuggestions.js';
import { cx } from '../lib/cx.js';
import { evaluationCounts } from '../lib/expression.js';
import { formatClock, toMs } from '../lib/format.js';
import {
  expressionCompletions,
  rankSuggestions,
  wordAt,
  type CompletionSources,
  type Suggestion,
} from '../lib/suggest.js';
import { ArtifactChip } from './ArtifactChip.js';
import type { ControlProps } from './controlProps.js';
import styles from './ExpressionEditor.module.css';
import { Skeleton } from './Skeleton.js';
import { SuggestionList } from './SuggestionList.js';
import { Textarea } from './Textarea.js';

export type EvaluationRow = FilterPreviewResponse['rows'][number];

export interface ExpressionInsertion {
  label: string;
  /** Defaults to `label`. */
  insert?: string;
  title?: string;
}

export interface ExpressionEditorProps extends ControlProps<string> {
  label: string;
  /** Omit to hide the evaluation panel. */
  rows?: EvaluationRow[];
  evaluating?: boolean;
  previewError?: string | null;
  insertions?: ExpressionInsertion[];
  summarize?: (row: EvaluationRow) => ReactNode;
  /** Rows shown before "show all N". */
  visibleRows?: number;
  textareaRows?: number;
  scope?: string;
  completions?: CompletionSources;
}

function defaultSummary(row: EvaluationRow): string {
  return Object.entries(row.attributes)
    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ');
}

/** Chips that insert a fragment (like `"name": `) are not completions. */
function chipCompletions(insertions: ExpressionInsertion[]): Suggestion[] {
  return insertions
    .filter((i) => i.insert === undefined)
    .map((i) => ({ value: i.label, hint: 'insert', ...(i.title ? { detail: i.title } : {}) }));
}

export function ExpressionEditor({
  value,
  onChange,
  label,
  id,
  describedBy,
  rows,
  evaluating,
  previewError,
  insertions = [],
  summarize = defaultSummary,
  visibleRows = 6,
  textareaRows = 2,
  scope = 'last 20 real events of these types',
  disabled,
  invalid,
  completions,
}: ExpressionEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const candidates = expressionCompletions({
    context: null,
    ...completions,
    extra: [...(completions?.extra ?? []), ...chipCompletions(insertions)],
  });

  const complete = (s: Suggestion) => {
    const el = ref.current;
    const cursor = el?.selectionStart ?? value.length;
    const { start } = wordAt(value, cursor);
    const next = value.slice(0, start) + s.value + value.slice(cursor);
    // A function lands with the cursor between its parentheses.
    const caret = start + s.value.length - (s.value.endsWith('()') ? 1 : 0);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };
  const suggest = useSuggestions(complete);
  const refresh = (text: string, cursor: number, force = false) => {
    const { word } = wordAt(text, cursor);
    if (word === '' && !force) {
      suggest.close();
      return;
    }
    const ranked = rankSuggestions(candidates, word);
    if (ranked.length > 0) suggest.show(ranked);
    else suggest.close();
  };

  const insert = (snippet: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + snippet + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.editor}>
        <Textarea
          ref={ref}
          id={id}
          aria-label={id ? undefined : label}
          aria-describedby={describedBy}
          {...suggest.inputProps}
          mono
          invalid={invalid}
          rows={textareaRows}
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
            refresh(e.target.value, e.target.selectionStart);
          }}
          onBlur={suggest.close}
          onKeyDown={(e) => {
            if (suggest.onKeyDown(e)) return;
            if (e.key === ' ' && e.ctrlKey) {
              e.preventDefault();
              refresh(value, e.currentTarget.selectionStart, true);
            }
          }}
        />
        <SuggestionList state={suggest} label={`Completions for ${label}`} />
      </div>
      {insertions.length > 0 && (
        <div className={styles.insert}>
          <span>insert</span>
          {insertions.map((ins) => (
            <button
              key={ins.label}
              type="button"
              className={styles.insertButton}
              title={ins.title}
              disabled={disabled}
              onClick={() => {
                insert(ins.insert ?? ins.label);
              }}
            >
              {ins.label}
            </button>
          ))}
          <span className={styles.note}>JSONata · 2 s limit</span>
        </div>
      )}
      {(rows != null || evaluating === true || previewError != null) && (
        <EvaluationPanel
          rows={rows}
          evaluating={evaluating}
          previewError={previewError}
          summarize={summarize}
          visibleRows={visibleRows}
          scope={scope}
        />
      )}
    </div>
  );
}

function EvaluationPanel({
  rows,
  evaluating,
  previewError,
  summarize,
  visibleRows,
  scope,
}: {
  rows: EvaluationRow[] | undefined;
  evaluating: boolean | undefined;
  previewError: string | null | undefined;
  summarize: (row: EvaluationRow) => ReactNode;
  visibleRows: number;
  scope: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const counts = rows ? evaluationCounts(rows) : null;
  const shown = rows ? (showAll ? rows : rows.slice(0, visibleRows)) : [];
  return (
    <section className={styles.panel} aria-label="Live evaluation">
      <div className={styles.summary} aria-live="polite">
        {previewError ? (
          <span className={styles.errorCount}>Preview unavailable — {previewError}</span>
        ) : counts ? (
          <span>
            {scope} · <span className={styles.trueCount}>{counts.true} true</span> · {counts.false}{' '}
            false ·{' '}
            <span className={counts.errors > 0 ? styles.errorCount : undefined}>
              {counts.errors} error{counts.errors === 1 ? '' : 's'}
            </span>
          </span>
        ) : (
          <span>Evaluating…</span>
        )}
      </div>
      {evaluating && !rows && <Skeleton lines={3} height={18} label="Evaluating" />}
      {rows?.length === 0 && (
        <div className={styles.summary}>No recent events of these types yet.</div>
      )}
      {shown.length > 0 && (
        <ul className={styles.rows}>
          {shown.map((row) => {
            const state = row.error ? 'error' : row.result ? 'true' : 'false';
            return (
              <li
                key={row.eventId}
                className={cx(styles.row, state === 'false' && styles.false)}
                data-result={state}
              >
                <span className={styles.time}>{formatClock(toMs(row.occurredAt) ?? 0)}</span>
                <ArtifactChip artifact={row.artifact} showIcon={false} />
                <span className={styles.text}>{summarize(row)}</span>
                <span className={styles.result}>
                  <span
                    className={styles.resultDot}
                    aria-hidden="true"
                    style={{
                      background:
                        state === 'error'
                          ? 'var(--st-err)'
                          : state === 'true'
                            ? 'var(--st-ok)'
                            : 'var(--line-strong)',
                    }}
                  />
                  {state}
                </span>
                {row.error && <span className={styles.rowError}>{row.error}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {rows && rows.length > visibleRows && (
        <button
          type="button"
          className={styles.more}
          onClick={() => {
            setShowAll((v) => !v);
          }}
        >
          {showAll ? 'show fewer' : `show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}
