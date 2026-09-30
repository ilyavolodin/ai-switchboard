import type { ReactNode } from 'react';

import { errorMessage } from '../../api/client.js';
import { Banner } from '../../components/Banner.js';

/** What installing a plugin means, shown before anyone installs one; `children` adds specifics. */
export function PluginTrustNote({
  inspectError,
  children,
}: {
  inspectError: Error | null;
  children: ReactNode;
}) {
  return (
    <>
      {inspectError && (
        <Banner tone="error" title="The package could not be inspected">
          {errorMessage(inspectError)}
        </Banner>
      )}
      <Banner tone="info" icon="info">
        Plugins run in the core&apos;s process as trusted code. {children}
      </Banner>
    </>
  );
}
