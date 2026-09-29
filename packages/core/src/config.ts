import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { parseOtelConfig, type OtelConfig } from './telemetry/otel-config.js';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowedDomains: string[];
}

export interface CoreConfig {
  databaseUrl: string;
  host: string;
  port: number;
  publicUrl: string;
  /** `$SWITCHBOARD_HOME`: installed plugins, lockfile, local state. */
  home: string;
  /** Local admin password, unauthenticated webhooks allowed. */
  evaluation: boolean;
  bootstrapAdmin: string | undefined;
  oidc: OidcConfig | undefined;
  logLevel: string;
  prettyLogs: boolean;
  telemetry: OtelConfig;
  replicaId: string;
  version: string;
  uiDir: string;
  /** Each a `node_modules`. */
  pluginDirs: string[];
  /** Load plugins from their `switchboard.source` TypeScript entry (dev with tsx). */
  devSource: boolean;
  npmRegistry: string;
  /** How often a replica installs plugins recorded in the database but missing locally. */
  pluginSyncSeconds: number;
  /** How often a replica rebuilds instances changed on another replica. */
  instanceSyncSeconds: number;
  /** False for an API-only replica (no pipeline workers, no scheduler). */
  workers: boolean;
  trustProxy: boolean;
  secureCookies: boolean;
}

export const CORE_VERSION = '1.0.0';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const port = Number(env.PORT ?? env.SWITCHBOARD_PORT ?? 8080);
  const publicUrl = (env.SWITCHBOARD_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const issuer = env.SWITCHBOARD_OIDC_ISSUER;
  const registry = env.SWITCHBOARD_NPM_REGISTRY;
  const oidc =
    issuer !== undefined && issuer !== ''
      ? {
          issuer,
          clientId: env.SWITCHBOARD_OIDC_CLIENT_ID ?? '',
          clientSecret: env.SWITCHBOARD_OIDC_CLIENT_SECRET ?? '',
          allowedDomains: list(env.SWITCHBOARD_OIDC_ALLOWED_DOMAINS),
        }
      : undefined;
  return {
    databaseUrl:
      env.DATABASE_URL ?? 'postgres://switchboard:switchboard@localhost:5432/switchboard',
    host: env.HOST ?? '0.0.0.0',
    port,
    publicUrl,
    home: resolve(env.SWITCHBOARD_HOME ?? '.switchboard'),
    evaluation: bool(env.SWITCHBOARD_EVALUATION, false),
    bootstrapAdmin: env.SWITCHBOARD_BOOTSTRAP_ADMIN,
    oidc,
    logLevel: env.LOG_LEVEL ?? 'info',
    prettyLogs: bool(env.SWITCHBOARD_PRETTY_LOGS, false),
    telemetry: parseOtelConfig(env),
    replicaId: env.SWITCHBOARD_REPLICA_ID ?? `${hostname()}-${randomUUID().slice(0, 8)}`,
    version: CORE_VERSION,
    uiDir: resolve(env.SWITCHBOARD_UI_DIR ?? new URL('../public', import.meta.url).pathname),
    pluginDirs: list(env.SWITCHBOARD_PLUGIN_DIRS),
    devSource: bool(env.SWITCHBOARD_DEV_SOURCE, false),
    npmRegistry: (registry !== undefined && registry !== ''
      ? registry
      : 'https://registry.npmjs.org'
    ).replace(/\/+$/, ''),
    pluginSyncSeconds: Math.max(Number(env.SWITCHBOARD_PLUGIN_SYNC_SECONDS ?? 60) || 60, 5),
    instanceSyncSeconds: Math.max(Number(env.SWITCHBOARD_INSTANCE_SYNC_SECONDS ?? 10) || 10, 1),
    workers: bool(env.SWITCHBOARD_WORKERS, true),
    trustProxy: bool(env.SWITCHBOARD_TRUST_PROXY, false),
    secureCookies: bool(env.SWITCHBOARD_SECURE_COOKIES, publicUrl.startsWith('https://')),
  };
}

/** A config for tests: evaluation mode, no telemetry export, no Prometheus, fixed replica id. */
export function testConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    ...loadConfig({}),
    databaseUrl: 'postgres://invalid',
    publicUrl: 'http://switchboard.test',
    evaluation: true,
    telemetry: parseOtelConfig({ SWITCHBOARD_PROMETHEUS: 'false' }),
    replicaId: 'test-replica',
    secureCookies: false,
    ...overrides,
  };
}
