import { useParams } from 'react-router';

import { Card } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { LinkButton } from '../components/LinkButton.js';

/**
 * A placeholder for a screen not built yet. Screen agents replace the route's `element` in
 * `routes.tsx` with the real screen.
 */
export function ComingSoon({ screen }: { screen: string }) {
  const params = useParams();
  const detail = Object.entries(params)
    .filter(([k]) => k !== '*')
    .map(([k, v]) => `${k}: ${v ?? ''}`)
    .join(' · ');
  return (
    <>
      <h1 className="t-screen-title">{screen}</h1>
      <Card>
        <EmptyState
          title={`${screen} is coming soon`}
          illustration="ghost"
          actions={
            <LinkButton to="/" variant="outline" size="sm" icon="board">
              Back to the Board
            </LinkButton>
          }
        >
          This screen is part of the design and not built yet.
          {detail ? <div className="mono t-caption">{detail}</div> : null}
        </EmptyState>
      </Card>
    </>
  );
}
