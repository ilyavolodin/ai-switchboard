export { loadConfig, testConfig, CORE_VERSION } from './config.js';
export type { CoreConfig, OidcConfig } from './config.js';
export { runDoctor } from './doctor.js';
export type { DoctorCheck } from './doctor.js';
export { createSwitchboard } from './app.js';
export type { Switchboard, CreateOptions } from './app.js';
export { PluginHost } from './plugins/host.js';
export type { PluginRuntime, LiveSource, LiveExecutor, LiveNotifier } from './plugins/runtime.js';
export { FakeClock, systemClock } from './clock.js';
export type { Clock } from './clock.js';
export {
  installPlugin,
  inspectPlugin,
  removePlugin,
  listInstalled,
  isPluginInstallError,
  PluginInstallError,
  defaultRunNpm,
  pluginsDir,
  lockfilePath,
} from './plugins/install.js';
export type {
  RunNpm,
  InstallOptions,
  InstallResult,
  InspectOptions,
  InspectResult,
  InstalledPlugin,
  RemoveOptions,
  PluginLockEntry,
  PluginLockfile,
  PluginManifestSummary,
} from './plugins/install.js';
export { accountRecovery } from './recovery.js';
export type { AccountRecovery, RecoveryRequest } from './recovery.js';
export { RecoveryError, isRecoveryError, closeEmails } from './services/recovery.js';
export type {
  AccountSummary,
  TemporaryPasswordResult,
  RecoveryErrorCode,
} from './services/recovery.js';
