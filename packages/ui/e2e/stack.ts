/**
 * The real stack the e2e suite runs against: Postgres in Docker, the stub server and the built
 * core (serving the built UI), plus a tiny typed client for seeding and polling through the API.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const LOG_DIR = join(REPO_ROOT, 'packages/ui/test-results/e2e-stack');

export const ADMIN_EMAIL = 'admin@switchboard.local';
export const ADMIN_PASSWORD = 'e2e-admin-password';
export const WEBHOOK_SECRET = 'e2e-webhook-secret';
export const CALLBACK_SECRET = 'e2e-callback-secret-0123456789';

/** What global setup hands the tests (through `process.env.E2E_STATE`). */
export interface StackState {
  baseUrl: string;
  stubUrl: string;
  token: string;
  sourceId: string;
  executorId: string;
  breakerProcessId: string;
  healthyProcessId: string;
  approvalProcessId: string;
  /** Artifact id of the event that ran the healthy process. */
  artifactId: string;
}

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns a value other than undefined, or throw after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${what}${suffix}`);
}

function startProcess(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): ChildProcess {
  mkdirSync(LOG_DIR, { recursive: true });
  const log = createWriteStream(join(LOG_DIR, `${name}.log`));
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (child?.exitCode !== null) return;
  const exited = new Promise<boolean>((r) => child.once('exit', () => r(true)));
  child.kill('SIGTERM');
  const done = await Promise.race([exited, sleep(10_000).then(() => false)]);
  if (!done) child.kill('SIGKILL');
}

/** The processes and containers global setup starts; `stop()` removes all of them. */
export interface Stack {
  baseUrl: string;
  stubUrl: string;
  stop(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  const [pgPort, stubPort, port] = [await freePort(), await freePort(), await freePort()];
  const container = `switchboard-e2e-${process.pid}-${Date.now()}`;
  const home = await mkdtemp(join(tmpdir(), 'switchboard-e2e-'));
  let stub: ChildProcess | undefined;
  let server: ChildProcess | undefined;

  const stop = async (): Promise<void> => {
    await stopProcess(server);
    await stopProcess(stub);
    await run('docker', ['rm', '-f', container]).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  };

  try {
    await run('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      container,
      '-e',
      'POSTGRES_USER=switchboard',
      '-e',
      'POSTGRES_PASSWORD=switchboard',
      '-e',
      'POSTGRES_DB=switchboard',
      '-p',
      `127.0.0.1:${pgPort}:5432`,
      'postgres:17-alpine',
    ]);
    await waitFor(
      'Postgres',
      async () => {
        // pg_isready over TCP: the entrypoint's first (socket-only) server doesn't count.
        await run('docker', [
          'exec',
          container,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'switchboard',
          '-d',
          'switchboard',
        ]);
        return true;
      },
      60_000,
    );

    const stubUrl = `http://127.0.0.1:${stubPort}`;
    stub = startProcess(
      'stub',
      process.execPath,
      [join(REPO_ROOT, 'deploy/stub/server.js')],
      { STUB_PORT: String(stubPort), STUB_CALLBACK_SECRET: CALLBACK_SECRET },
      REPO_ROOT,
    );
    await waitFor('the stub', async () =>
      (await fetch(`${stubUrl}/healthz`)).ok ? true : undefined,
    );

    const baseUrl = `http://127.0.0.1:${port}`;
    server = startProcess(
      'switchboard',
      process.execPath,
      [join(REPO_ROOT, 'packages/core/dist/main.js')],
      {
        DATABASE_URL: `postgres://switchboard:switchboard@127.0.0.1:${pgPort}/switchboard`,
        PORT: String(port),
        HOST: '127.0.0.1',
        SWITCHBOARD_PUBLIC_URL: baseUrl,
        SWITCHBOARD_EVALUATION: 'true',
        SWITCHBOARD_ADMIN_PASSWORD: ADMIN_PASSWORD,
        SWITCHBOARD_HOME: home,
        SWITCHBOARD_PROMETHEUS: 'false',
        LOG_LEVEL: 'info',
        // Read by the `env` secret provider as secret://env/<NAME>.
        WEBHOOK_SECRET,
        STUB_CALLBACK_SECRET: CALLBACK_SECRET,
      },
      join(REPO_ROOT, 'packages/core'),
    );
    await waitFor(
      'the switchboard server (see test-results/e2e-stack/switchboard.log)',
      async () => {
        if (server?.exitCode !== null) throw new Error('the server exited');
        return (await fetch(`${baseUrl}/readyz`)).ok ? true : undefined;
      },
      60_000,
    );
    return { baseUrl, stubUrl, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** A JSON client for the API, authenticated with a bearer token or a session cookie. */
export class Api {
  constructor(
    readonly baseUrl: string,
    private auth: { token?: string; cookie?: string } = {},
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.auth.token) headers.authorization = `Bearer ${this.auth.token}`;
    if (this.auth.cookie) headers.cookie = this.auth.cookie;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /** Sign in as the local admin and mint an admin API token. */
  static async signIn(baseUrl: string): Promise<Api> {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (!res.ok) throw new Error(`login → ${res.status}: ${await res.text()}`);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const session = new Api(baseUrl, { cookie });
    const created = await session.post<{ secret: string }>('/api/v1/tokens', {
      name: 'e2e seed',
      role: 'admin',
      reason: 'e2e seed',
    });
    return new Api(baseUrl, { token: created.secret });
  }

  get token(): string {
    return this.auth.token ?? '';
  }
}

/**
 * Ask the stub to sign and send one alert to a source's webhook; returns the alert id (the
 * event's artifact id). `route` becomes the event's `route` attribute, which the seeded
 * processes filter on.
 */
export async function sendAlert(
  stubUrl: string,
  baseUrl: string,
  sourceId: string,
  route: 'breaker' | 'healthy' | 'approval',
): Promise<string> {
  const target = `${baseUrl}/hooks/${sourceId}`;
  const url = new URL(`${stubUrl}/send`);
  url.searchParams.set('target', target);
  url.searchParams.set('secret', WEBHOOK_SECRET);
  url.searchParams.set('type', route);
  const res = await fetch(url, { method: 'POST' });
  const body = (await res.json()) as { ok: boolean; status: number; event: { id: string } };
  if (!body.ok) throw new Error(`webhook delivery answered ${body.status}`);
  return body.event.id;
}
