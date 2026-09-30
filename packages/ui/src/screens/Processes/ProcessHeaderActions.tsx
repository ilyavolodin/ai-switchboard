import { Button } from '../../components/Button.js';
import { LinkButton } from '../../components/LinkButton.js';
import { Toggle } from '../../components/Toggle.js';
import type { ProcessActions } from './useProcessActions.js';

export function ProcessHeaderActions({
  processId,
  enabled,
  actions,
}: {
  processId: string;
  enabled: boolean;
  actions: ProcessActions;
}) {
  return (
    <>
      <LinkButton
        to={`/processes/${encodeURIComponent(processId)}/edit`}
        variant="outline"
        icon="edit"
      >
        Edit
      </LinkButton>
      <Button
        variant="primary"
        icon="play"
        requires="operator"
        loading={actions.runNow.pending}
        disabled={!enabled}
        disabledReason="Enable the process to run it"
        onClick={actions.runNow.run}
      >
        Run now
      </Button>
      <Button
        variant="danger-outline"
        icon="trash"
        requires="operator"
        loading={actions.remove.pending}
        onClick={actions.remove.run}
      >
        Delete
      </Button>
      <Toggle
        boxed
        label="Enabled"
        value={enabled}
        requires="operator"
        onChange={actions.setEnabled}
      />
    </>
  );
}
