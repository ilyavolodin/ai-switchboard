import { RunsTable } from '../shared/RunsTable.js';

export function RunsTab({ processId }: { processId: string }) {
  return (
    <RunsTable
      preset="process"
      filter={{ process: processId }}
      caption="Runs of this process"
      empty="No runs yet. Run now or wait for a trigger."
    />
  );
}
