import { Link } from 'react-router';

import { useEvent } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { WhyNothingRan } from '../../components/WhyNothingRan.js';
import { traceHref } from '../../lib/artifact.js';
import { whyFromExplanations } from '../../lib/why.js';

export function TestEventResult({
  eventIds,
  onDismiss,
}: {
  eventIds: readonly string[];
  onDismiss: () => void;
}) {
  const [first] = eventIds;
  const event = useEvent(first, { untilMatched: true });
  const d = event.data;
  const taken = d?.explanations.filter((x) => x.taken) ?? [];
  const why = whyFromExplanations(d?.explanations ?? []);
  const waiting = !d || d.stage === 'received';
  const nothing = !waiting && taken.length === 0 && d.processes.length === 0;

  const title = waiting
    ? 'Test event sent: waiting for match'
    : nothing
      ? 'Test event sent: nothing ran'
      : `Test event sent: taken by ${
          taken.map((x) => x.processName).join(', ') || d.processes.map((p) => p.name).join(', ')
        }`;

  return (
    <Banner
      tone={nothing ? 'warn' : 'info'}
      title={title}
      actions={
        <>
          {first && (
            <Link to={traceHref(first)} className="t-caption">
              Open its trace
            </Link>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label="Dismiss the test event result"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        </>
      }
    >
      {event.isError ? (
        'The event could not be read back; open its trace to see what happened.'
      ) : waiting ? (
        'The pipeline matches it in a moment.'
      ) : nothing ? (
        why.length > 0 ? (
          <WhyNothingRan items={why} label="Why nothing ran" />
        ) : d.stage === 'unmatched' ? (
          'No process has a trigger on this source. Add one in a process editor.'
        ) : (
          `It stopped at the door: ${d.indicator.label}${d.stageReason ? ` (${d.stageReason})` : ''}.`
        )
      ) : (
        d.indicator.label
      )}
      {eventIds.length > 1 && ` ${eventIds.length} events were sent; this is the first.`}
    </Banner>
  );
}
