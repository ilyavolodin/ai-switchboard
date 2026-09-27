import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  /** Public base URL used for webhook and callback URLs and OIDC redirects. */
  publicUrl: string;
  /** `$SWITCHBOARD_HOME`: installed plugins, lockfile, local state. */
  home: string;
  /** Evaluation mode (Compose quick start): local admin password, unauthenticated webhooks allowed. */
  evaluation: boolean;
  /** Email of the first admin, who signs in through OIDC. */
  bootstrapAdmin: string | undefined;
  oidc: OidcConfig | undefined;
  logLevel: string;
  prettyLogs: boolean;
  metrics: { prometheus: boolean; otlpEndpoint: string | undefined };
  replicaId: string;
  version: string;
  /** Directory with the built UI (`packages/core/public`). */
  uiDir: string;
  /** Extra directories scanned for plugin packages (each a `node_modules`). */
  pluginDirs: string[];
  /** Load plugins from their `switchboard.source` TypeScript entry (dev with tsx). */
  devSource: boolean;
  /** Run pipeline workers and the scheduler in this process (false for an API-only replica). */
  workers: boolean;
  /** Secure cookies (true unless publicUrl is plain http). */
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
    metrics: {
      prometheus: bool(env.SWITCHBOARD_PROMETHEUS, true),
      otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
    replicaId: env.SWITCHBOARD_REPLICA_ID ?? `${hostname()}-${randomUUID().slice(0, 8)}`,
    version: CORE_VERSION,
    uiDir: resolve(env.SWITCHBOARD_UI_DIR ?? new URL('../public', import.meta.url).pathname),
    pluginDirs: list(env.SWITCHBOARD_PLUGIN_DIRS),
    devSource: bool(env.SWITCHBOARD_DEV_SOURCE, false),
    workers: bool(env.SWITCHBOARD_WORKERS, true),
    secureCookies: bool(env.SWITCHBOARD_SECURE_COOKIES, publicUrl.startsWith('https://')),
  };
}

/** A config for tests: evaluation mode, no Prometheus, fixed replica id. */
export function testConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    ...loadConfig({}),
    databaseUrl: 'postgres://invalid',
    publicUrl: 'http://switchboard.test',
    evaluation: true,
    metrics: { prometheus: false, otlpEndpoint: undefined },
    replicaId: 'test-replica',
    secureCookies: false,
    ...overrides,
  };
}
