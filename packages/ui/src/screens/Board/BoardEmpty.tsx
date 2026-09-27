import { Card } from '../../components/Card.js';
import { Icon } from '../../components/Icon.js';
import { LinkButton } from '../../components/LinkButton.js';
import { NodeCard } from '../../components/NodeCard.js';
import styles from './Board.module.css';

/**
 * The Board's first-run state: three steps (add a source, add an executor, draw your first
 * process) over a canvas of ghost nodes. Steps already done are ticked.
 */
export function BoardEmpty({ sources, executors }: { sources: number; executors: number }) {
  const steps = [
    {
      done: sources > 0,
      title: 'Add a source',
      body: 'Connect GitHub, Linear, Datadog or any webhook. Its events are what start your processes.',
      to: '/sources',
      cta: 'Add a source',
    },
    {
      done: executors > 0,
      title: 'Add an executor',
      body: 'Point at the automation you already have: a Claude Routine, an HTTP endpoint, a GitHub Actions workflow.',
      to: '/executors',
      cta: 'Add an executor',
    },
    {
      done: false,
      title: 'Draw your first process',
      body: 'Pick the events that matter, set batching, gates and budgets, and bind it to the executor.',
      to: '/processes/new',
      cta: 'New process',
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <Card className={styles.emptyCard} aria-label="Get started">
      <div className={styles.ghostCanvas} aria-hidden="true">
        <NodeCard tone="off" title="Your source" meta="push" ghost width={170}>
          events · 24 h
        </NodeCard>
        <span className={styles.ghostEdge} />
        <NodeCard tone="off" title="Your first process" ghost width={200}>
          matched › batched › gated › invoked › ok
        </NodeCard>
        <span className={styles.ghostEdge} />
        <NodeCard tone="off" title="Your executor" meta="callback" ghost width={170}>
          meters
        </NodeCard>
      </div>
      <h2 className="t-card-title">Nothing is wired yet</h2>
      <ol className={styles.steps}>
        {steps.map((s, i) => (
          <li key={s.title} className={styles.step} data-done={s.done || undefined}>
            <span className={styles.stepNumber} aria-hidden="true">
              {s.done ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <span className={styles.stepText}>
              <span className={styles.stepTitle}>
                {s.title}
                {s.done && <span className="visually-hidden"> (done)</span>}
              </span>
              <span className="t-caption">{s.body}</span>
            </span>
            {!s.done && (
              <LinkButton to={s.to} size="sm" variant={i === next ? 'primary' : 'outline'}>
                {s.cta}
              </LinkButton>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
