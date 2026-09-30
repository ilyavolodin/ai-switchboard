import { resolve } from 'node:path';

import type { Command } from 'commander';

import { DEFAULT_HOME } from '@ai-switchboard/core/domain';

import { DEFAULT_URL } from './api.js';
import type { CliIO } from './deps.js';

export interface ServerFlags {
  url?: string;
  token?: string;
}

export interface HomeFlags {
  home?: string;
}

export interface JsonFlags {
  json?: boolean;
}

export function serverFlags(cmd: Command): Command {
  return cmd
    .option('--url <url>', `server base URL (env SWITCHBOARD_URL, default ${DEFAULT_URL})`)
    .option('--token <token>', 'API token sent as Authorization: Bearer (env SWITCHBOARD_TOKEN)');
}

export function homeOption(cmd: Command): Command {
  return cmd.option(
    '--home <dir>',
    `$SWITCHBOARD_HOME: installs go to <dir>/plugins (env SWITCHBOARD_HOME, default ./${DEFAULT_HOME})`,
  );
}

export function jsonOption(cmd: Command, what = 'the result'): Command {
  return cmd.option('--json', `print ${what} as JSON`);
}

/** The same rule as the server's config: `--home`, else `$SWITCHBOARD_HOME`, else the default. */
export function homeDir(opts: HomeFlags, env: NodeJS.ProcessEnv): string {
  return resolve(opts.home ?? env.SWITCHBOARD_HOME ?? DEFAULT_HOME);
}

/** `--json` prints `value` as JSON; otherwise `render` writes the human form. */
export function printResult<T>(
  io: CliIO,
  opts: JsonFlags,
  value: T,
  render: (value: T) => void,
): void {
  if (opts.json === true) io.out(JSON.stringify(value, null, 2));
  else render(value);
}
