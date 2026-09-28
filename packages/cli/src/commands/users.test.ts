import { describe, expect, it } from 'vitest';

import type {
  AccountRecovery,
  AccountSummary,
  RecoveryRequest,
  TemporaryPasswordResult,
} from '@ai-switchboard/core';

import type { CliDeps } from '../deps.js';
import { buildProgram } from '../main.js';
import { DEFAULT_ADMIN_REASON, DEFAULT_RESET_REASON } from './users.js';

interface Captured {
  out: string[];
  err: string[];
  exitCode: number;
}

type Call = [keyof AccountRecovery, unknown, RecoveryRequest?];

const accounts: AccountSummary[] = [
  {
    email: 'admin@switchboard.local',
    role: 'admin',
    hasPassword: true,
    hasOidc: false,
    mustChangePassword: true,
    lastLoginAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  {
    email: 'carol@acme.test',
    role: 'operator',
    hasPassword: false,
    hasOidc: true,
    mustChangePassword: false,
    lastLoginAt: '2026-09-27T10:00:00.000Z',
    createdAt: '2026-09-02T00:00:00.000Z',
  },
];

const unknownUser = (suggestions: string[]): Error =>
  Object.assign(new Error('No account has the email x.'), {
    name: 'RecoveryError',
    code: 'unknown_user',
    suggestions,
  });

function harness(recovery: Partial<AccountRecovery> = {}): {
  calls: Call[];
  run: (...argv: string[]) => Promise<Captured>;
} {
  const calls: Call[] = [];
  const temporary = (r: RecoveryRequest): TemporaryPasswordResult => ({
    email: r.email.toLowerCase(),
    role: 'admin',
    password: r.password ?? 'abcde-fghjk-mnpqr-stuvw',
    generated: r.password === undefined,
  });
  const fake: AccountRecovery = {
    listUsers: (config) => {
      calls.push(['listUsers', config]);
      return Promise.resolve(accounts);
    },
    resetPassword: (config, r) => {
      calls.push(['resetPassword', config, r]);
      return Promise.resolve(temporary(r));
    },
    createAdmin: (config, r) => {
      calls.push(['createAdmin', config, r]);
      return Promise.resolve({ ...temporary(r), change: 'created' });
    },
    ...recovery,
  };
  const run = async (...argv: string[]): Promise<Captured> => {
    const cap: Captured = { out: [], err: [], exitCode: 0 };
    const deps: Partial<CliDeps> = {
      io: {
        out: (t) => cap.out.push(t),
        err: (t) => cap.err.push(t),
        setExitCode: (c) => {
          cap.exitCode = c;
        },
      },
      env: { DATABASE_URL: 'postgres://db/switchboard' },
      loadConfig: ((env: NodeJS.ProcessEnv) =>
        Promise.resolve({ databaseUrl: env.DATABASE_URL })) as unknown as CliDeps['loadConfig'],
      recovery: fake,
      hostname: () => 'box-1',
    };
    try {
      await buildProgram(deps, { exitOverride: true }).parseAsync(['node', 'switchboard', ...argv]);
    } catch (err) {
      const code = (err as { exitCode?: number }).exitCode;
      if (code === undefined) throw err;
      cap.exitCode = code;
    }
    return cap;
  };
  return { calls, run };
}

describe('switchboard users list', () => {
  it('prints every account with its sign-in methods, using the server environment', async () => {
    const { calls, run } = harness();
    const cap = await run('users', 'list');
    expect(cap.exitCode).toBe(0);
    expect(calls).toEqual([['listUsers', { databaseUrl: 'postgres://db/switchboard' }]]);
    const text = cap.out.join('\n');
    expect(text).toMatch(/EMAIL\s+ROLE\s+PASSWORD\s+OIDC\s+MUST CHANGE\s+LAST SIGN-IN/);
    expect(text).toMatch(/admin@switchboard\.local\s+admin\s+yes\s+no\s+yes\s+never/);
    expect(text).toMatch(/carol@acme\.test\s+operator\s+no\s+yes\s+no\s+2026-09-27T10:00:00/);
  });

  it('prints JSON with --json', async () => {
    const { run } = harness();
    const cap = await run('users', 'list', '--json');
    expect(JSON.parse(cap.out.join('\n'))).toEqual(accounts);
  });

  it('says so when there are no accounts', async () => {
    const { run } = harness({ listUsers: () => Promise.resolve([]) });
    expect((await run('users', 'list')).out.join('\n')).toMatch(/No accounts yet/);
  });
});

describe('switchboard users reset-password', () => {
  it('generates a temporary password by default, audits as cli@<hostname> and prints it once', async () => {
    const { calls, run } = harness();
    const cap = await run('users', 'reset-password', 'admin@switchboard.local');
    expect(cap.exitCode).toBe(0);
    expect(calls).toEqual([
      [
        'resetPassword',
        { databaseUrl: 'postgres://db/switchboard' },
        { email: 'admin@switchboard.local', actor: 'cli@box-1', reason: DEFAULT_RESET_REASON },
      ],
    ]);
    const text = cap.out.join('\n');
    expect(text.match(/abcde-fghjk-mnpqr-stuvw/g)).toHaveLength(1);
    expect(text).toMatch(/changed at the next sign-in/);
    expect(text).toMatch(/signed out/);
  });

  it('passes --password and --reason through and does not echo a given password', async () => {
    const { calls, run } = harness();
    const cap = await run(
      'users',
      'reset-password',
      'carol@acme.test',
      '--password',
      'quiet-harbour-lamp-7',
      '--reason',
      'carol locked out',
    );
    expect(calls[0]?.[2]).toEqual({
      email: 'carol@acme.test',
      password: 'quiet-harbour-lamp-7',
      actor: 'cli@box-1',
      reason: 'carol locked out',
    });
    expect(cap.out.join('\n')).not.toContain('quiet-harbour-lamp-7');
  });

  it('refuses --password together with --generate', async () => {
    const { calls, run } = harness();
    const cap = await run('users', 'reset-password', 'a@b.c', '--password', 'x', '--generate');
    expect(cap.exitCode).toBe(1);
    expect(cap.err.join('\n')).toMatch(/either --password or --generate/);
    expect(calls).toEqual([]);
  });

  it('refuses an unknown email and lists close matches', async () => {
    const { run } = harness({
      resetPassword: () => Promise.reject(unknownUser(['admin@switchboard.local'])),
    });
    const cap = await run('users', 'reset-password', 'Admin@Switchboard.Lokal');
    expect(cap.exitCode).toBe(1);
    const err = cap.err.join('\n');
    expect(err).toMatch(/no account has the email admin@switchboard\.lokal/);
    expect(err).toMatch(/Did you mean:\n {2}admin@switchboard\.local/);
    expect(err).toMatch(/switchboard users list/);
    expect(cap.out).toEqual([]);
  });

  it('prints any other refusal as an error', async () => {
    const { run } = harness({
      resetPassword: () => Promise.reject(new Error('Use at least 12 characters.')),
    });
    const cap = await run('users', 'reset-password', 'a@b.c', '--password', 'short');
    expect(cap.exitCode).toBe(1);
    expect(cap.err).toEqual(['error: Use at least 12 characters.']);
  });
});

describe('switchboard users create-admin', () => {
  it('creates a break-glass admin with a generated temporary password', async () => {
    const { calls, run } = harness();
    const cap = await run('users', 'create-admin', 'ops@acme.test');
    expect(cap.exitCode).toBe(0);
    expect(calls[0]?.[2]).toEqual({
      email: 'ops@acme.test',
      actor: 'cli@box-1',
      reason: DEFAULT_ADMIN_REASON,
    });
    const text = cap.out.join('\n');
    expect(text).toMatch(/Created the admin ops@acme\.test/);
    expect(text).toContain('abcde-fghjk-mnpqr-stuvw');
  });

  it('reports a promotion', async () => {
    const { run } = harness({
      createAdmin: (_c, r) =>
        Promise.resolve({
          email: r.email,
          role: 'admin',
          password: 'p',
          generated: true,
          change: 'promoted',
        }),
    });
    expect((await run('users', 'create-admin', 'carol@acme.test')).out[0]).toBe(
      'Promoted carol@acme.test to admin.',
    );
  });
});
