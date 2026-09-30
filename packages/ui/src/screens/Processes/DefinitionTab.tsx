import type { ProcessDocument } from '@ai-switchboard/core/contract';

import { Card } from '../../components/Card.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { LinkButton } from '../../components/LinkButton.js';
import { QuietHoursBar } from '../../components/QuietHoursBar.js';
import { StatusChip } from '../../components/StatusChip.js';
import { describeCron } from '../../lib/cron.js';
import { asRecord } from '../../lib/instances.js';
import { approvalMode, batchingSummary, budgetsSummary } from './editorModel.js';
import styles from './ProcessDetail.module.css';
import { useEditorLookups } from './useEditorLookups.js';

function Expr({ value }: { value: string | undefined }) {
  return value ? (
    <code className={styles.expr}>{value}</code>
  ) : (
    <span className="t-caption">—</span>
  );
}

export function DefinitionTab({ processId, doc }: { processId: string; doc: ProcessDocument }) {
  const names = useEditorLookups();
  const sourceName = (id: string) => names.sourceName(id) || id;
  const providerName = (id: string) => names.providerName(id) || id;
  const notifierName = (id: string) => names.notifierName(id) || id;
  const destinationName =
    names.destinationSummary(doc.destination.instanceId)?.name ?? doc.destination.instanceId;
  const g = doc.gates;
  const target = asRecord(doc.destination.target);

  return (
    <div className={styles.definition}>
      <div className={styles.row}>
        <span className="t-caption">
          The stored document. Every change is a new version with a reason.
        </span>
        <span className={styles.grow} />
        <LinkButton
          to={`/processes/${encodeURIComponent(processId)}/edit`}
          variant="primary"
          size="sm"
          icon="edit"
        >
          Edit
        </LinkButton>
      </div>

      <Card title="Triggers" meta={doc.triggers.length}>
        {doc.triggers.length === 0 ? (
          <p className="t-caption">No triggers — only sweeps start this process.</p>
        ) : (
          <ul className={styles.plainList}>
            {doc.triggers.map((t) => (
              <li key={t.id} className={styles.defItem}>
                <div className={styles.row}>
                  <strong>{t.describe || t.eventTypes.join(', ')}</strong>
                  <StatusChip
                    tone={t.enabled ? 'ok' : 'off'}
                    label={t.enabled ? 'on' : 'off'}
                    size="sm"
                  />
                </div>
                <span className="t-caption">
                  {sourceName(t.sourceId)} ·{' '}
                  <span className="mono">{t.eventTypes.join(' · ')}</span>
                </span>
                {t.filter && <Expr value={t.filter} />}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className={styles.defGrid}>
        <Card title="Batching">
          <p className={styles.defText}>{batchingSummary(doc.batching)}</p>
        </Card>
        <Card title="Schedules" meta={doc.schedules.length}>
          {doc.schedules.length === 0 ? (
            <p className="t-caption">No sweeps.</p>
          ) : (
            <ul className={styles.plainList}>
              {doc.schedules.map((s) => {
                const d = describeCron(s.cron);
                return (
                  <li key={s.id} className={styles.defItem}>
                    <span>
                      <span className="mono">{s.cron}</span> · {d ? `${d} · ` : ''}
                      {s.timezone}
                    </span>
                    <span className="t-caption">
                      catch-up {s.catchUp}
                      {s.enabled ? '' : ' · off'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="Gates">
          <QuietHoursBar value={g.quietHours} />
          <KeyValueList
            data={[
              [
                'approval',
                approvalMode(g.approval) === 'expression' ? (
                  <Expr key="a" value={g.approval} />
                ) : (
                  g.approval
                ),
              ],
              [
                'breaker',
                `${g.breaker.threshold} failures · cooldown ${g.breaker.cooldownMinutes} min`,
              ],
            ]}
          />
        </Card>
        <Card title="Budgets">
          <p className={styles.defText}>{budgetsSummary(doc.budgets)}</p>
          {Object.keys(doc.budgets.meterCeilings).length > 0 && (
            <KeyValueList
              label="Meter ceilings"
              data={Object.fromEntries(
                Object.entries(doc.budgets.meterCeilings).map(([m, c]) => [
                  m,
                  `events ${c.events}% · sweeps ${c.sweeps}%`,
                ]),
              )}
            />
          )}
        </Card>
      </div>

      <Card title="Destination" meta={destinationName}>
        <KeyValueList label="Target" data={target} />
        <span className="t-overline">input mapping</span>
        <CodeBlock value={doc.input} label="Input mapping" />
        <span className="t-caption">tracking deadline {doc.trackingDeadlineMinutes} min</span>
      </Card>

      <div className={styles.defGrid}>
        <Card title="Steps" meta={doc.before.length + doc.after.length}>
          {doc.before.length + doc.after.length === 0 ? (
            <p className="t-caption">No steps.</p>
          ) : (
            <ul className={styles.plainList}>
              {[
                ...doc.before.map((s) => ['before', s] as const),
                ...doc.after.map((s) => ['after', s] as const),
              ].map(([phase, s], i) => (
                <li key={i} className={styles.defItem}>
                  <span>
                    <span className="t-overline">{phase}</span>{' '}
                    <span className="mono">
                      {providerName(s.provider)} · {s.action}
                    </span>
                  </span>
                  <Expr value={s.args} />
                  {s.when && (
                    <span className="t-caption">
                      when <code className="mono">{s.when}</code>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Notifications" meta={doc.notify.length}>
          {doc.notify.length === 0 ? (
            <p className="t-caption">No notifications.</p>
          ) : (
            <ul className={styles.plainList}>
              {doc.notify.map((n, i) => (
                <li key={i} className={styles.defItem}>
                  <span>
                    {notifierName(n.notifierId)} on {n.on.join(', ')}
                  </span>
                  <Expr value={n.template} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
