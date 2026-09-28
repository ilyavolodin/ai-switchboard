import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DoctorCheck, InstallResult } from '@ai-switchboard/core';
import type { ApplyResponse } from '@ai-switchboard/core/contract';

import type { CliDeps, Installer } from './deps.js';
import { buildProgram, CLI_VERSION } from './main.js';

interface Captured {
  out: string[];
  err: string[];
  exitCode: number;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function harness(overrides: Partial<CliDeps> = {}): {
  cap: Captured;
  run: (...argv: string[]) => Promise<Captured>;
} {
  const cap: Captured = { out: [], err: [], exitCode: 0 };
  const deps: Partial<CliDeps> = {
    io: {
      out: (t) => cap.out.push(t),
      err: (t) => cap.err.push(t),
      setExitCode: (c) => {
        cap.exitCode = c;
      },
    },
    env: {},
    ...overrides,
  };
  return {
    cap,
    run: async (...argv) => {
      const program = buildProgram(deps, { exitOverride: true });
      try {
        await program.parseAsync(['node', 'switchboard', ...argv]);
      } catch (err) {
        const code = (err as { exitCode?: number }).exitCode;
        if (code === undefined) throw err;
        cap.exitCode = code;
      }
      return cap;
    },
  };
}

function stubFetch(
  reply: (call: FetchCall) => { status: number; body: string; type?: string },
): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: FetchCall = {
      url: input.toString(),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = reply(call);
    return Promise.resolve(
      new Response(r.body, {
        status: r.status,
        headers: { 'content-type': r.type ?? 'application/json' },
      }),
    );
  };
  return Object.assign(fn, { calls }) as typeof fetch & { calls: FetchCall[] };
}

const installResult: InstallResult = {
  name: '@acme/switchboard-source-jira',
  version: '1.2.0',
  integrity: 'sha512-abcdefghijklmnopqrstuvwxyz==',
  sdkRange: '^2.0.0',
  compatible: true,
  capabilities: { network: ['*.atlassian.net'], secrets: ['api-token'] },
  plugin: {
    pluginId: 'acme-jira',
    displayName: 'Jira',
    types: [{ kind: 'source', typeId: 'jira', displayName: 'Jira' }],
  },
  manifestPath: '/home/plugins/node_modules/@acme/switchboard-source-jira/package.json',
  warnings: [],
};

function fakeInstaller(calls: unknown[]): Installer {
  return {
    install: (o) => {
      calls.push(['install', o]);
      return Promise.resolve(installResult);
    },
    remove: (o) => {
      calls.push(['remove', o]);
      return Promise.resolve();
    },
    list: (home) => {
      calls.push(['list', home]);
      return Promise.resolve([
        {
          name: '@acme/switchboard-source-jira',
          version: '1.2.0',
          integrity: 'sha512-abcdefghijklmnopqrstuvwxyz==',
          sdk: '^2.0.0',
          installedAt: '2026-09-27T12:00:00.000Z',
          spec: '@acme/switchboard-source-jira@^1',
        },
      ]);
    },
    inspect: (o) => {
      calls.push(['inspect', o]);
      return Promise.resolve({ ...installResult, compatible: false, sdkRange: '^3.0.0' });
    },
  };
}

describe('switchboard (program)', () => {
  it('prints the version', async () => {
    const { run } = harness();
    const cap = await run('--version');
    expect(cap.out.join('')).toContain(`switchboard ${CLI_VERSION}`);
    expect(cap.exitCode).toBe(0);
  });

  it('lists every command in --help', async () => {
    const { run } = harness();
    const cap = await run('--help');
    const help = cap.out.join('');
    for (const cmd of ['plugins', 'export', 'apply', 'doctor', 'serve'])
      expect(help).toContain(cmd);
    expect(help).toContain('SWITCHBOARD_TOKEN');
  });

  it('fails on an unknown command with a usage hint', async () => {
    const { run } = harness();
    const cap = await run('frobnicate');
    expect(cap.exitCode).toBe(1);
    expect(cap.err.join('')).toMatch(/unknown command/);
  });
});

describe('switchboard plugins', () => {
  it('add installs into --home and prints version, integrity and capabilities', async () => {
    const calls: unknown[] = [];
    const { run } = harness({ installer: fakeInstaller(calls) });
    const cap = await run(
      'plugins',
      'add',
      '@acme/switchboard-source-jira@^1',
      '--home',
      '/srv/sb',
    );

    expect(calls).toEqual([
      [
        'install',
        { home: resolve('/srv/sb'), spec: '@acme/switchboard-source-jira@^1', allowSource: false },
      ],
    ]);
    const out = cap.out.join('\n');
    expect(out).toContain('Installed @acme/switchboard-source-jira 1.2.0');
    expect(out).toContain('sha512-abcdefghijklmnopqrstuvwxyz==');
    expect(out).toContain('*.atlassian.net');
    expect(out).toContain('api-token');
    expect(out).toContain('next start');
    expect(cap.exitCode).toBe(0);
  });

  it('add uses SWITCHBOARD_HOME when --home is absent', async () => {
    const calls: unknown[] = [];
    const { run } = harness({
      installer: fakeInstaller(calls),
      env: { SWITCHBOARD_HOME: '/opt/switchboard' },
    });
    await run('plugins', 'add', 'x');
    expect(calls[0]).toEqual(['install', expect.objectContaining({ home: '/opt/switchboard' })]);
  });

  it('add reports an installer error and exits 1', async () => {
    const { run } = harness({
      installer: {
        ...fakeInstaller([]),
        install: () => Promise.reject(new Error('left-pad is not a Switchboard plugin')),
      },
    });
    const cap = await run('plugins', 'add', 'left-pad');
    expect(cap.exitCode).toBe(1);
    expect(cap.err.join('\n')).toContain('error: left-pad is not a Switchboard plugin');
  });

  it('list prints a table from the lockfile', async () => {
    const { run } = harness({ installer: fakeInstaller([]) });
    const cap = await run('plugins', 'list', '--home', '/srv/sb');
    const out = cap.out.join('\n');
    expect(out).toMatch(/NAME\s+VERSION\s+SDK\s+INSTALLED\s+INTEGRITY/);
    expect(out).toContain('@acme/switchboard-source-jira  1.2.0');
  });

  it('remove calls the installer with the package name', async () => {
    const calls: unknown[] = [];
    const { run } = harness({ installer: fakeInstaller(calls) });
    const cap = await run('plugins', 'remove', '@acme/switchboard-source-jira', '--home', '/h');
    expect(calls).toEqual([
      ['remove', { home: resolve('/h'), name: '@acme/switchboard-source-jira' }],
    ]);
    expect(cap.out.join('\n')).toContain('Removed @acme/switchboard-source-jira');
  });

  it('inspect exits 1 for an incompatible SDK range', async () => {
    const { run } = harness({ installer: fakeInstaller([]) });
    const cap = await run('plugins', 'inspect', '@acme/switchboard-source-jira@2');
    expect(cap.out.join('\n')).toMatch(/compatible\s+no/);
    expect(cap.exitCode).toBe(1);
  });
});

describe('switchboard export', () => {
  it('GETs /api/v1/export with the bearer token and writes the file', async () => {
    const fetch = stubFetch(() => ({
      status: 200,
      body: 'apiVersion: switchboard/v1\n',
      type: 'text/yaml',
    }));
    const written: [string, string][] = [];
    const { run } = harness({
      fetch,
      env: { SWITCHBOARD_URL: 'https://sb.example.com/', SWITCHBOARD_TOKEN: 'tok-env' },
      writeFile: (p, c) => {
        written.push([p, c]);
        return Promise.resolve();
      },
    });
    const cap = await run('export', '-o', 'out.yaml');
    expect(fetch.calls[0]?.url).toBe('https://sb.example.com/api/v1/export');
    expect(fetch.calls[0]?.headers.authorization).toBe('Bearer tok-env');
    expect(written).toEqual([['out.yaml', 'apiVersion: switchboard/v1\n']]);
    expect(cap.exitCode).toBe(0);
  });

  it('prints to stdout and lets --url/--token override the environment', async () => {
    const fetch = stubFetch(() => ({ status: 200, body: 'kind: Configuration\n' }));
    const { run } = harness({ fetch, env: { SWITCHBOARD_TOKEN: 'env' } });
    const cap = await run('export', '--url', 'http://other:9000', '--token', 'flag');
    expect(fetch.calls[0]?.url).toBe('http://other:9000/api/v1/export');
    expect(fetch.calls[0]?.headers.authorization).toBe('Bearer flag');
    expect(cap.out.join('')).toContain('kind: Configuration');
  });

  it('shows the API error message and a hint on 401', async () => {
    const fetch = stubFetch(() => ({
      status: 401,
      body: JSON.stringify({ error: 'unauthorized', message: 'sign in required' }),
    }));
    const { run } = harness({ fetch });
    const cap = await run('export');
    expect(fetch.calls[0]?.url).toBe('http://localhost:8080/api/v1/export');
    expect(cap.exitCode).toBe(1);
    expect(cap.err.join('\n')).toMatch(/sign in required.*SWITCHBOARD_TOKEN/);
  });
});

describe('switchboard apply', () => {
  const yaml = 'apiVersion: switchboard/v1\nkind: Configuration\nprocesses: []\n';
  const readFile = (): Promise<string> => Promise.resolve(yaml);

  it('POSTs the YAML with reason and dry-run, and prints the change list', async () => {
    const response: ApplyResponse = {
      dryRun: true,
      changes: [
        { kind: 'source', name: 'GitHub — acme org', action: 'create' },
        { kind: 'process', name: 'Autofix', action: 'update' },
        { kind: 'destination', name: 'Stub', action: 'unchanged' },
      ],
      errors: [],
    };
    const fetch = stubFetch(() => ({ status: 200, body: JSON.stringify(response) }));
    const { run } = harness({ fetch, readFile });
    const cap = await run('apply', '-f', 'sb.yaml', '--dry-run', '--reason', 'staging sync');

    expect(fetch.calls[0]).toMatchObject({
      url: 'http://localhost:8080/api/v1/apply',
      method: 'POST',
      body: { yaml, reason: 'staging sync', dryRun: true },
    });
    const out = cap.out.join('\n');
    expect(out).toContain('Dry run');
    expect(out).toMatch(/\+\s+create\s+source\s+GitHub — acme org/);
    expect(out).toMatch(/~\s+update\s+process\s+Autofix/);
    expect(out).toContain('1 to create, 1 to update, 0 to delete, 1 unchanged.');
    expect(cap.exitCode).toBe(0);
  });

  it('prints errors and exits 1 when the server reports any', async () => {
    const response: ApplyResponse = {
      dryRun: false,
      changes: [],
      errors: ['processes[0].destination.instance: no destination named "Missing"'],
    };
    const fetch = stubFetch(() => ({ status: 200, body: JSON.stringify(response) }));
    const { run } = harness({ fetch, readFile });
    const cap = await run('apply', '-f', 'sb.yaml', '--reason', 'r');
    expect(cap.err.join('\n')).toContain('no destination named "Missing"');
    expect(cap.exitCode).toBe(1);
  });

  it('names the server when a 200 answer is not JSON (a proxy page, the wrong URL)', async () => {
    const fetch = stubFetch(() => ({ status: 200, body: '<html>login</html>', type: 'text/html' }));
    const { run } = harness({ fetch, readFile });
    const cap = await run('apply', '-f', 'sb.yaml', '--reason', 'r');
    expect(cap.exitCode).toBe(1);
    expect(cap.err.join('\n')).toContain(
      'error: http://localhost:8080 returned a non-JSON answer to POST /apply',
    );
  });

  it('leaves --reason to the server: sends an empty reason and shows its 400', async () => {
    const fetch = stubFetch(() => ({
      status: 400,
      body: JSON.stringify({
        error: 'bad_request',
        message: 'A reason is required for every change.',
        details: ['reason must be a non-empty string'],
      }),
    }));
    const { run } = harness({ fetch, readFile });
    const cap = await run('apply', '-f', 'sb.yaml');
    expect(fetch.calls[0]).toMatchObject({ body: { yaml, reason: '' } });
    expect(cap.exitCode).toBe(1);
    expect(cap.err.join('\n')).toContain('A reason is required for every change.');
  });

  it('applies without --reason when the server makes reasons optional', async () => {
    const response: ApplyResponse = { dryRun: false, changes: [], errors: [] };
    const fetch = stubFetch(() => ({ status: 200, body: JSON.stringify(response) }));
    const { run } = harness({ fetch, readFile });
    const cap = await run('apply', '-f', 'sb.yaml');
    expect(cap.exitCode).toBe(0);
    expect(cap.out.join('\n')).toContain('Applied to');
  });

  it('rejects invalid YAML before calling the server', async () => {
    const fetch = stubFetch(() => ({ status: 200, body: '{}' }));
    const { run } = harness({ fetch, readFile: () => Promise.resolve('a: [1, 2\n') });
    const cap = await run('apply', '-f', 'bad.yaml', '--reason', 'r');
    expect(cap.exitCode).toBe(1);
    expect(cap.err.join('')).toMatch(/bad\.yaml/);
    expect(fetch.calls).toHaveLength(0);
  });

  it('prints validation details from a 400', async () => {
    const fetch = stubFetch(() => ({
      status: 400,
      body: JSON.stringify({ error: 'invalid', message: 'invalid configuration', details: ['x'] }),
    }));
    const { run } = harness({ fetch, readFile });
    const cap = await run('apply', '-f', 'sb.yaml', '--reason', 'r');
    expect(cap.err.join('\n')).toMatch(/invalid configuration[\s\S]*- x/);
    expect(cap.exitCode).toBe(1);
  });
});

describe('switchboard doctor', () => {
  const doctor = (checks: DoctorCheck[]) => ({
    runDoctor: () => Promise.resolve(checks),
    loadConfig: ((env: NodeJS.ProcessEnv) =>
      Promise.resolve({ env })) as unknown as CliDeps['loadConfig'],
  });

  it('prints ✓ lines and exits 0 when every check passes', async () => {
    const { run } = harness(doctor([{ name: 'database', ok: true, detail: 'reachable' }]));
    const cap = await run('doctor');
    expect(cap.out).toContain('✓ database — reachable');
    expect(cap.exitCode).toBe(0);
  });

  it('prints ✗ lines and exits 1 when any check fails', async () => {
    const { run } = harness(
      doctor([
        { name: 'database', ok: true, detail: 'reachable' },
        { name: 'secret GITHUB_TOKEN', ok: false, detail: 'not set' },
      ]),
    );
    const cap = await run('doctor');
    expect(cap.out).toContain('✗ secret GITHUB_TOKEN — not set');
    expect(cap.out.join('\n')).toContain('1 of 2 checks failed.');
    expect(cap.exitCode).toBe(1);
  });
});

describe('switchboard serve', () => {
  it('spawns the core server entry with PORT and SWITCHBOARD_HOME set', async () => {
    const spawned: [string, NodeJS.ProcessEnv][] = [];
    const { run } = harness({
      env: { DATABASE_URL: 'postgres://x' },
      resolveServerEntry: () => Promise.resolve('/app/core/dist/main.js'),
      spawnServer: (entry, env) => {
        spawned.push([entry, env]);
        return Promise.resolve(0);
      },
    });
    const cap = await run('serve', '--port', '9000', '--home', '/opt/sb');
    expect(spawned).toEqual([
      [
        '/app/core/dist/main.js',
        { DATABASE_URL: 'postgres://x', PORT: '9000', SWITCHBOARD_HOME: '/opt/sb' },
      ],
    ]);
    expect(cap.exitCode).toBe(0);
  });

  it('passes a non-zero server exit code through', async () => {
    const { run } = harness({
      resolveServerEntry: () => Promise.resolve('/x/dist/main.js'),
      spawnServer: () => Promise.resolve(3),
    });
    expect((await run('serve')).exitCode).toBe(3);
  });

  it('rejects an invalid port', async () => {
    const { run } = harness({ spawnServer: () => Promise.resolve(0) });
    const cap = await run('serve', '--port', 'abc');
    expect(cap.exitCode).toBe(1);
  });
});
