import type { DestinationDetail } from '@ai-switchboard/core/contract';

import { RunsTable } from '../shared/RunsTable.js';

export function DestinationRuns({ destination }: { destination: DestinationDetail }) {
  return (
    <RunsTable
      preset="destination"
      filter={{ destination: destination.id }}
      caption={`Runs on ${destination.name}`}
      empty="No runs on this destination yet."
      units={new Map(destination.usage.map((u) => [u.id, u.unit]))}
    />
  );
}
