import { join } from 'node:path';

import { SDK_VERSION } from '@ai-switchboard/sdk';
import semver from 'semver';

import { exists } from '../util/fs.js';
import { isRecord, str } from '../util/guards.js';

/** The `switchboard` field of a plugin's `package.json`, as the host requires it. */
export interface SwitchboardField {
  entry: string;
  source: string | undefined;
  sdk: string;
}

export type SwitchboardFieldCheck =
  { ok: true; field: SwitchboardField } | { ok: false; reason: string };

/** The one rule the installer and discovery share for what counts as a plugin package. */
export function parseSwitchboardField(pkg: unknown): SwitchboardFieldCheck {
  if (!isRecord(pkg) || !isRecord(pkg.switchboard))
    return { ok: false, reason: 'its package.json has no "switchboard" field' };
  const f = pkg.switchboard;
  const entry = str(f.entry);
  const sdk = str(f.sdk);
  if (entry === undefined) return { ok: false, reason: 'its "switchboard" field has no "entry"' };
  if (sdk === undefined) return { ok: false, reason: 'its "switchboard" field has no "sdk" range' };
  return { ok: true, field: { entry, source: str(f.source), sdk } };
}

/**
 * The file to import, relative to the package: the source in dev (tsx) or when the entry is not
 * built. The installer reads capabilities from the file the host will load.
 */
export async function pluginEntry(
  dir: string,
  field: SwitchboardField,
  devSource: boolean,
): Promise<string> {
  if (field.source === undefined) return field.entry;
  return devSource || !(await exists(join(dir, field.entry))) ? field.source : field.entry;
}

/** The one compatibility rule the installer and the host share. */
export function isSdkCompatible(range: string, sdkVersion: string = SDK_VERSION): boolean {
  return (
    semver.validRange(range) !== null &&
    semver.satisfies(sdkVersion, range, { includePrerelease: true })
  );
}
