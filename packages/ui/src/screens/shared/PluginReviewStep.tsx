import type {
  InspectPluginRequest,
  InspectPluginResponse,
  PluginSearchResult,
} from '@ai-switchboard/core/contract';
import type { UseMutationResult } from '@tanstack/react-query';

import { errorMessage } from '../../api/client.js';
import { Banner } from '../../components/Banner.js';
import { Skeleton } from '../../components/Skeleton.js';
import styles from './forms.module.css';
import { ManifestReview } from './ManifestReview.js';

export function PluginReviewStep({
  review,
  inspect,
  manifest,
}: {
  review: PluginSearchResult;
  inspect: UseMutationResult<InspectPluginResponse, Error, InspectPluginRequest>;
  manifest: InspectPluginResponse | null;
}) {
  return (
    <div className={styles.stack}>
      <p className={styles.note}>
        {review.description || review.package} Read what it asks for before installing.
      </p>
      {inspect.isPending && <Skeleton lines={3} height={32} label="Reading the manifest" />}
      {inspect.isError && (
        <Banner tone="error" title="The package could not be inspected">
          {errorMessage(inspect.error)}
        </Banner>
      )}
      {manifest && <ManifestReview manifest={manifest} />}
      <Banner tone="info" icon="info">
        Plugins run in the core&apos;s process as trusted code. Installing one needs the admin role
        and a reason, and is recorded in the audit log.
      </Banner>
    </div>
  );
}
