import type { InspectPluginResponse, PluginSearchResult } from '@ai-switchboard/core/contract';

import { Skeleton } from '../../components/Skeleton.js';
import styles from './forms.module.css';
import { ManifestReview } from './ManifestReview.js';
import { PluginTrustNote } from './PluginTrustNote.js';

export function PluginReviewStep({
  review,
  inspecting,
  manifest,
  inspectError,
}: {
  review: PluginSearchResult;
  inspecting: boolean;
  manifest: InspectPluginResponse | null;
  inspectError: Error | null;
}) {
  return (
    <div className={styles.stack}>
      <p className={styles.note}>
        {review.description || review.package} Read what it asks for before installing.
      </p>
      {inspecting && <Skeleton lines={3} height={32} label="Reading the manifest" />}
      {manifest && <ManifestReview manifest={manifest} />}
      <PluginTrustNote inspectError={inspectError}>
        Installing one needs the admin role and a reason, and is recorded in the audit log.
      </PluginTrustNote>
    </div>
  );
}
