import type { ProcessDetail } from '@ai-switchboard/core/contract';

import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';

export function ConflictBanner({
  baseVersion,
  stored,
  onLoadStored,
  onKeepMine,
}: {
  baseVersion: number;
  stored: ProcessDetail | undefined;
  onLoadStored: (stored: ProcessDetail) => void;
  onKeepMine: (stored: ProcessDetail) => void;
}) {
  return (
    <Banner
      tone="error"
      title="Someone else saved this process while you were editing"
      actions={
        stored && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onLoadStored(stored);
              }}
            >
              Load version {stored.version} (drop my changes)
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onKeepMine(stored);
              }}
            >
              Keep my changes
            </Button>
          </>
        )
      }
    >
      Nothing was saved. Your changes are based on version {baseVersion}
      {stored && stored.version !== baseVersion
        ? `; the stored version is now ${stored.version}`
        : ''}
      . Load the latest to see what changed, or keep your changes and save again to replace it.
    </Banner>
  );
}
