import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';

export function InstanceStateBanners({
  noun,
  typeName,
  pluginAvailable,
  instanceError,
  heldProcesses,
  onReload,
}: {
  noun: string;
  typeName: string;
  pluginAvailable: boolean;
  instanceError: string | null | undefined;
  heldProcesses: string;
  onReload: () => void;
}) {
  return (
    <>
      {!pluginAvailable && (
        <Banner tone="warn" title="Plugin unavailable">
          The {typeName} plugin did not load at start. This {noun} stays configured, but{' '}
          {heldProcesses} until the plugin is back.
        </Banner>
      )}
      {instanceError && (
        <Banner
          tone="error"
          title={`The ${noun} is not running`}
          actions={
            <Button size="sm" variant="outline" requires="operator" onClick={onReload}>
              Reload
            </Button>
          }
        >
          {instanceError}
        </Banner>
      )}
    </>
  );
}
