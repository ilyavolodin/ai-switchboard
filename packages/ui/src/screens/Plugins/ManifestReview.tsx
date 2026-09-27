import type { InspectPluginResponse } from '@ai-switchboard/core/contract';

import { KeyValueList } from '../../components/KeyValueList.js';
import { StatusChip } from '../../components/StatusChip.js';
import styles from '../Sources/forms.module.css';
import { kindLabel, networkText, secretsText } from './pluginModel.js';

/**
 * What a package asks for, read from npm before anything is installed: the resolved version, SDK
 * compatibility, the types it contributes and its declared network and secret capabilities.
 */
export function ManifestReview({ manifest }: { manifest: InspectPluginResponse }) {
  return (
    <section className={styles.caps} aria-label="Manifest">
      <div className={styles.footer}>
        <span className={styles.legend}>
          Manifest · resolved <span className="mono">{manifest.version}</span>
        </span>
        <span className={styles.spacer} />
        {manifest.compatible ? (
          <StatusChip tone="ok" size="sm" label={`sdk ${manifest.sdkRange} ok`} />
        ) : (
          <StatusChip tone="error" size="sm" label={`incompatible · sdk ${manifest.sdkRange}`} />
        )}
      </div>
      <KeyValueList
        label="Manifest capabilities"
        data={[
          [
            'contributes',
            manifest.types.length
              ? manifest.types.map((t) => `${t.displayName} ${kindLabel(t.kind)}`).join(', ')
              : 'nothing',
          ],
          ['network', <span className="mono">{networkText(manifest.capabilities)}</span>],
          ['secrets', <span className="mono">{secretsText(manifest.capabilities)}</span>],
          [
            'integrity',
            <span className="mono">
              {manifest.integrity ?? 'unknown'} · pinned in plugins.lock.json
            </span>,
          ],
        ]}
      />
    </section>
  );
}
