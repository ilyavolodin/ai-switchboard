import type { AttentionItem } from '@ai-switchboard/core/contract';
import { useNavigate } from 'react-router';

import {
  useApprove,
  useEnableProcess,
  useReadMeters,
  useReloadDestination,
  useReloadSource,
  useResetBreaker,
  useSendTestEvent,
} from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Time } from '../../components/Time.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { toneVars } from '../../lib/tone.js';
import {
  approvePrompt,
  enableProcessPrompt,
  readMetersPrompt,
  reloadedMessage,
  reloadPrompt,
  resetBreakerPrompt,
  testEventPrompt,
} from '../shared/actionPrompts.js';
import styles from './Board.module.css';
import { attentionHref } from './facts.js';

type Run = (item: AttentionItem) => Promise<unknown>;

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const navigate = useNavigate();
  const reset = useReasonedMutation(useResetBreaker(), resetBreakerPrompt(), {
    successMessage: 'Breaker reset',
  });
  const approve = useReasonedMutation(useApprove(), approvePrompt(), {
    successMessage: 'Approved — the batch re-entered the gate',
  });
  const reloadSource = useReasonedMutation(useReloadSource(), reloadPrompt('source'), {
    successMessage: reloadedMessage('source'),
  });
  const reloadDestination = useReasonedMutation(
    useReloadDestination(),
    reloadPrompt('destination'),
    { successMessage: reloadedMessage('destination') },
  );
  const readMeters = useReasonedMutation(useReadMeters(), readMetersPrompt(), {
    successMessage: (d) => `Read ${d.length} meter${d.length === 1 ? '' : 's'}`,
  });
  const testEvent = useReasonedMutation(useSendTestEvent(), testEventPrompt(), {
    successMessage: 'Test event sent',
  });
  const enableProcess = useReasonedMutation(
    useEnableProcess(),
    enableProcessPrompt(undefined, true),
    {
      successMessage: 'Process enabled',
    },
  );

  const handlers: Record<string, Run | undefined> = {
    enable_process: (i) => enableProcess.run({ id: i.targetId, enabled: true }),
    reset_breaker: (i) => reset.run({ id: i.targetId }),
    approve: (i) => approve.run({ batchId: i.targetId }),
    reload: (i) =>
      i.targetKind === 'destination'
        ? reloadDestination.run({ id: i.targetId })
        : reloadSource.run({ id: i.targetId }),
    read_meters: (i) => readMeters.run({ id: i.targetId }),
    test_event: (i) => testEvent.run({ id: i.targetId }),
  };

  return (
    <Card
      title="Needs attention"
      meta={items.length}
      className={styles.attention}
      aria-label="Needs attention"
    >
      {items.length === 0 ? (
        <EmptyState compact title="Nothing needs you">
          No open breakers, unhealthy instances, stale meters, silent sources or pending approvals.
        </EmptyState>
      ) : (
        <ul className={styles.attentionList}>
          {items.map((item) => {
            const handler = handlers[item.action.id];
            return (
              <li key={item.id} className={styles.attentionRow}>
                <span
                  className={styles.attentionDot}
                  style={{ background: toneVars(item.tone).fill }}
                  aria-hidden="true"
                />
                <span className={styles.attentionText}>
                  <span className={styles.attentionTitle}>
                    <span className="visually-hidden">
                      {item.tone === 'error' ? 'Error: ' : 'Warning: '}
                    </span>
                    <a
                      href={attentionHref(item)}
                      onClick={(e) => {
                        e.preventDefault();
                        void navigate(attentionHref(item));
                      }}
                    >
                      {item.title}
                    </a>
                  </span>
                  <span className={styles.attentionDetail}>
                    {item.detail}
                    {item.since && (
                      <>
                        {' · '}
                        <Time value={item.since} />
                      </>
                    )}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  requires={handler ? 'operator' : undefined}
                  aria-label={`${item.action.label}: ${item.title}`}
                  onClick={() => {
                    if (handler) void handler(item);
                    else void navigate(attentionHref(item));
                  }}
                >
                  {item.action.label}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
