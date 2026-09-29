import { Command } from 'commander';

import type { TemporaryPasswordResult } from '@ai-switchboard/core';

import type { CliDeps } from '../deps.js';
import { table } from '../output.js';
import { run } from './run.js';

export const DEFAULT_RESET_REASON = 'password reset from the server CLI';
export const DEFAULT_ADMIN_REASON = 'break-glass admin from the server CLI';

interface PasswordOptions {
  password?: string;
  generate?: boolean;
  reason: string;
}

/** Reads the core's `RecoveryError` by shape, since it crosses the package boundary. */
function suggestionsOf(err: unknown): string[] | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { name?: unknown; code?: unknown; suggestions?: unknown };
  if (e.name !== 'RecoveryError' || e.code !== 'unknown_user') return undefined;
  return Array.isArray(e.suggestions) ? e.suggestions.map(String) : [];
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

function passwordFor(opts: PasswordOptions): string | undefined {
  if (opts.password !== undefined && opts.generate === true)
    throw new Error('Use either --password or --generate, not both.');
  return opts.password;
}

function printTemporary(deps: CliDeps, result: TemporaryPasswordResult, headline: string): void {
  const { io } = deps;
  io.out(headline);
  io.out('');
  io.out(`  email               ${result.email}`);
  io.out(
    `  temporary password  ${result.generated ? result.password : '(the one given with --password)'}`,
  );
  io.out('');
  io.out(
    result.generated
      ? 'Shown once: pass it on now. It must be changed at the next sign-in.'
      : 'It must be changed at the next sign-in.',
  );
  io.out('Every session of this account was signed out, and the audit log records the change.');
}

/**
 * Connects to `DATABASE_URL` rather than the HTTP API, so it works when nobody can sign in.
 * Server access is the credential.
 */
export function usersCommand(deps: CliDeps): Command {
  const { io } = deps;
  const actor = (): string => `cli@${deps.hostname()}`;
  const users = new Command('users').description(
    'Recover accounts on the server: list them, reset a password, or create a break-glass admin (uses DATABASE_URL)',
  );

  users
    .command('list')
    .description('List every account: email, role, sign-in methods, pending password change')
    .option('--json', 'print the accounts as JSON')
    .action(
      run(deps, async (opts: { json?: boolean }) => {
        const accounts = await deps.recovery.listUsers(await deps.loadConfig(deps.env));
        if (opts.json === true) {
          io.out(JSON.stringify(accounts, null, 2));
          return;
        }
        if (accounts.length === 0) {
          io.out('No accounts yet. The server creates the first admin when it starts.');
          return;
        }
        io.out(
          table(
            ['EMAIL', 'ROLE', 'PASSWORD', 'OIDC', 'MUST CHANGE', 'LAST SIGN-IN'],
            accounts.map((a) => [
              a.email,
              a.role,
              yesNo(a.hasPassword),
              yesNo(a.hasOidc),
              yesNo(a.mustChangePassword),
              a.lastLoginAt ?? 'never',
            ]),
          ),
        );
      }),
    );

  users
    .command('reset-password')
    .argument('<email>', 'the account to reset (see `switchboard users list`)')
    .description(
      'Set a temporary password, sign the account out everywhere and print the password once',
    )
    .option('--password <password>', 'use this temporary password (checked against the rules)')
    .option('--generate', 'generate the temporary password (the default)')
    .option('--reason <reason>', 'why, for the audit log', DEFAULT_RESET_REASON)
    .action(
      run(deps, async (email: string, opts: PasswordOptions) => {
        const password = passwordFor(opts);
        const config = await deps.loadConfig(deps.env);
        try {
          const result = await deps.recovery.resetPassword(config, {
            email,
            ...(password !== undefined ? { password } : {}),
            actor: actor(),
            reason: opts.reason,
          });
          printTemporary(deps, result, `Reset the password of ${result.email} (${result.role}).`);
        } catch (err) {
          const suggestions = suggestionsOf(err);
          if (suggestions === undefined) throw err;
          io.err(`error: no account has the email ${email.trim().toLowerCase()}.`);
          if (suggestions.length > 0) {
            io.err('Did you mean:');
            for (const s of suggestions) io.err(`  ${s}`);
          }
          io.err('Run `switchboard users list` to see every account.');
          io.setExitCode(1);
        }
      }),
    );

  users
    .command('create-admin')
    .argument('<email>', 'the admin account to create, or an existing account to promote')
    .description(
      'Break glass: create or promote a local admin with a temporary password, printed once',
    )
    .option('--password <password>', 'use this temporary password (checked against the rules)')
    .option('--generate', 'generate the temporary password (the default)')
    .option('--reason <reason>', 'why, for the audit log', DEFAULT_ADMIN_REASON)
    .action(
      run(deps, async (email: string, opts: PasswordOptions) => {
        const password = passwordFor(opts);
        const result = await deps.recovery.createAdmin(await deps.loadConfig(deps.env), {
          email,
          ...(password !== undefined ? { password } : {}),
          actor: actor(),
          reason: opts.reason,
        });
        const headline =
          result.change === 'created'
            ? `Created the admin ${result.email}.`
            : result.change === 'promoted'
              ? `Promoted ${result.email} to admin.`
              : `${result.email} is already an admin; its password was reset.`;
        printTemporary(deps, result, headline);
      }),
    );

  return users;
}
