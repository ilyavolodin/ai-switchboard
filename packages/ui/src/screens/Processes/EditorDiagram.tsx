import type {
  ExecutorSummary,
  ProcessDocument,
  SourceSummary,
  StatusLabel,
} from '@ai-switchboard/core/contract';

import { ExecutorNode } from '../../components/ExecutorNode.js';
import { Icon } from '../../components/Icon.js';
import { NodeCard } from '../../components/NodeCard.js';
import { SourceNode } from '../../components/SourceNode.js';
import { StatusChip } from '../../components/StatusChip.js';
import { cx } from '../../lib/cx.js';
import { describeCron } from '../../lib/cron.js';
import { batchingOn, batchingSummary, budgetsOn } from './editorModel.js';
import styles from './ProcessEditor.module.css';

export interface EditorDiagramProps {
  doc: ProcessDocument;
  sources: SourceSummary[];
  executor: ExecutorSummary | undefined;
  /** The saved process's id (for its ceiling marks); undefined while creating. */
  processId: string | undefined;
  status: StatusLabel | undefined;
}

function Connector() {
  return (
    <svg
      className={styles.connector}
      viewBox="0 0 48 12"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <line x1="0" y1="6" x2="42" y2="6" stroke="var(--line-strong)" strokeWidth="1.5" />
      <path d="M40 2 L46 6 L40 10" fill="none" stroke="var(--line-strong)" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * The editor's persistent picture: the triggers' sources on the left (event types beneath,
 * dimmed when the trigger is off), the process in the middle with its batching, gate, budget and
 * sweep badges, and the bound executor on the right with this process's ceilings on its meters.
 * Redraws on every edit.
 */
export function EditorDiagram({ doc, sources, executor, processId, status }: EditorDiagramProps) {
  const pid = processId ?? 'draft';
  const bySource = new Map<string, { on: boolean; types: string[] }>();
  for (const t of doc.triggers) {
    if (!t.sourceId) continue;
    const cur = bySource.get(t.sourceId) ?? { on: false, types: [] };
    cur.on = cur.on || t.enabled;
    if (t.enabled) cur.types = [...new Set([...cur.types, ...t.eventTypes])];
    bySource.set(t.sourceId, cur);
  }
  const g = doc.gates;
  const gateParts = [
    g.quietHours ? `quiet hours ${g.quietHours.start}–${g.quietHours.end}` : null,
    `approval ${g.approval === 'none' || g.approval === 'always' ? g.approval : 'expression'}`,
    `breaker ${g.breaker.threshold}/${g.breaker.cooldownMinutes} min`,
  ].filter(Boolean);
  const b = doc.budgets;
  const budgetParts = [
    b.runsPerHour != null ? `${b.runsPerHour}/h` : null,
    b.runsPerDay != null ? `${b.runsPerDay}/d` : null,
    Object.keys(b.usagePerDay ?? {}).length > 0 ? 'usage caps' : null,
  ].filter(Boolean);
  const sweep = doc.schedules.find((s) => s.enabled);
  const sweepText = sweep ? describeCron(sweep.cron) : null;

  const executorWithDraft = executor && {
    ...executor,
    meters: executor.meters.map((m) => {
      const c = doc.budgets.meterCeilings[m.meterId];
      return {
        ...m,
        ceilings: c
          ? [{ processId: pid, processName: doc.name, events: c.events, sweeps: c.sweeps }]
          : [],
      };
    }),
  };

  return (
    <figure className={styles.diagram} aria-label="Process diagram">
      <div className={styles.diagramColumn}>
        {bySource.size === 0 ? (
          <NodeCard
            tone="off"
            title={doc.schedules.length ? 'schedule only' : 'no triggers yet'}
            ghost
            width={220}
          >
            {doc.schedules.length ? 'sweeps start every run' : 'add a trigger below'}
          </NodeCard>
        ) : (
          [...bySource.entries()].map(([id, info]) => {
            const s = sources.find((x) => x.id === id);
            const node = {
              id,
              name: s?.name ?? id,
              typeName: s?.typeName ?? 'source',
              status: s?.status ?? { tone: 'off' as const, label: 'unknown' },
              enabled: s?.enabled ?? false,
              events24h: s?.eventsByType24h.reduce((a, x) => a + x.count, 0) ?? 0,
            };
            return (
              <div key={id} className={cx(!info.on && styles.dimmed)}>
                <SourceNode
                  source={node}
                  width={220}
                  detail={info.on ? info.types.join(' · ') || 'no event types' : 'trigger off'}
                />
              </div>
            );
          })
        )}
      </div>
      <Connector />
      <NodeCard
        tone={status?.tone ?? 'off'}
        title={doc.name || 'New process'}
        meta={status ? <StatusChip tone={status.tone} label={status.label} size="sm" /> : 'draft'}
        width={300}
      >
        <span className={styles.badges}>
          <span className={styles.badge} title={`batching: ${batchingSummary(doc.batching)}`}>
            <Icon name="clock" size={12} />
            {batchingOn(doc.batching) ? `batch ${doc.batching.debounceSeconds} s` : 'no batching'}
          </span>
          <span className={styles.badge} title={`gates: ${gateParts.join(' · ')}`}>
            <Icon name="gate" size={12} />
            {g.approval !== 'none' ? 'approval' : 'gates'}
          </span>
          <span className={styles.badge} title={`budgets: ${budgetParts.join(' · ') || 'none'}`}>
            <Icon name="budget" size={12} />
            {budgetParts[0] ?? (budgetsOn(doc.budgets) ? 'ceilings' : 'no limits')}
          </span>
          {sweep && (
            <span
              className={styles.badge}
              title={`sweep ${sweepText?.ok ? sweepText.text : sweep.cron} ${sweep.timezone}`}
            >
              <Icon name="refresh" size={12} />
              {sweep.cron}
            </span>
          )}
        </span>
      </NodeCard>
      <Connector />
      <div className={styles.diagramColumn}>
        {executorWithDraft ? (
          <ExecutorNode executor={executorWithDraft} width={300} processId={pid} />
        ) : (
          <NodeCard tone="off" title="no executor" ghost width={300}>
            choose one in Executor
          </NodeCard>
        )}
      </div>
    </figure>
  );
}
