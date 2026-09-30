export { loadConfig, testConfig, CORE_VERSION } from './config.js';
export { DEFAULT_HOME, DEFAULT_PORT } from './domain/defaults.js';
export type { CoreConfig, OidcConfig } from './config.js';
export { runDoctor } from './doctor.js';
export type { DoctorCheck } from './doctor.js';
export { createSwitchboard } from './app.js';
export type { Switchboard, CreateOptions } from './app.js';
export { PluginHost } from './plugins/host.js';
export type { BootOptions, PluginHostOptions } from './plugins/host.js';
export type { PluginAdminPort } from './plugins/admin-port.js';
export type {
  PluginRuntime,
  LiveSource,
  LiveDestination,
  LiveNotifier,
} from './plugins/runtime.js';
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
export { accountRecovery } from './account-recovery.js';
export type { AccountRecovery, RecoveryRequest } from './account-recovery.js';
export { RecoveryError, isRecoveryError } from './services/recovery.js';
export { closeEmails } from './util/emails.js';
export type {
  AccountSummary,
  TemporaryPasswordResult,
  RecoveryErrorCode,
} from './services/recovery.js';
