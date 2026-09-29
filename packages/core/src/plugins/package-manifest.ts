import { SDK_VERSION } from '@ai-switchboard/sdk';
import semver from 'semver';

import { isRecord, str } from '../util/guards.js';

/** The `switchboard` field of a plugin's `package.json`; each part is absent when not a non-empty string. */
export interface SwitchboardManifest {
  entry: string | undefined;
  source: string | undefined;
  sdk: string | undefined;
}

export function readSwitchboardField(pkg: unknown): SwitchboardManifest | undefined {
  if (!isRecord(pkg) || !isRecord(pkg.switchboard)) return undefined;
  const f = pkg.switchboard;
  return { entry: str(f.entry), source: str(f.source), sdk: str(f.sdk) };
}

/** The one compatibility rule the installer and the host share. */
export function isSdkCompatible(range: string, sdkVersion: string = SDK_VERSION): boolean {
  return (
    semver.validRange(range) !== null &&
    semver.satisfies(sdkVersion, range, { includePrerelease: true })
  );
}
