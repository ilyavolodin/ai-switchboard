import type { CoreConfig } from './config.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * `switchboard doctor`: database, migrations, plugin manifests, secret resolution and every
 * enabled instance's `health()`.
 */
export function runDoctor(_config: CoreConfig): Promise<DoctorCheck[]> {
  return Promise.resolve([{ name: 'doctor', ok: false, detail: 'not implemented yet' }]);
}
