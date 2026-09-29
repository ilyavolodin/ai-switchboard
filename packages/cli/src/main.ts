#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { SDK_VERSION } from '@ai-switchboard/sdk';

import { applyCommand, exportCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import { pluginsCommand } from './commands/plugins.js';
import { serveCommand } from './commands/serve.js';
import { usersCommand } from './commands/users.js';
import { defaultDeps, type CliDeps } from './deps.js';

/** The CLI and the core release together, so this is also the core version. */
export const CLI_VERSION = '1.0.0';

/** Every side effect goes through `deps`, so tests can stub them. */
export function buildProgram(
  overrides: Partial<CliDeps> = {},
  options: { exitOverride?: boolean } = {},
): Command {
  const deps: CliDeps = { ...defaultDeps(), ...overrides };
  const program = new Command('switchboard')
    .description(
      'AI Switchboard: manage plugins, export and apply configuration, check and start the server, recover accounts.',
    )
    .version(
      `switchboard ${CLI_VERSION} (sdk ${SDK_VERSION})`,
      '-V, --version',
      'print the version',
    )
    .showHelpAfterError('(run with --help for usage)')
    .configureOutput({
      writeOut: (text) => deps.io.out(text),
      writeErr: (text) => deps.io.err(text),
    })
    .addHelpText(
      'after',
      `
Environment:
  SWITCHBOARD_URL     server base URL for export/apply (default http://localhost:8080)
  SWITCHBOARD_TOKEN   API token for export/apply (Authorization: Bearer)
  SWITCHBOARD_HOME    plugins directory root for plugins add/remove/list (default ./.switchboard)
  DATABASE_URL, ...   doctor, serve and users read the same variables as the server

Examples:
  switchboard plugins add @acme/switchboard-source-jira@^1
  switchboard export -o switchboard.yaml
  switchboard apply -f switchboard.yaml --dry-run --reason "review staging config"
  switchboard doctor
  switchboard users reset-password admin@switchboard.local`,
    );

  program.addCommand(pluginsCommand(deps));
  program.addCommand(exportCommand(deps));
  program.addCommand(applyCommand(deps));
  program.addCommand(doctorCommand(deps));
  program.addCommand(serveCommand(deps));
  program.addCommand(usersCommand(deps));
  if (options.exitOverride === true) program.exitOverride();
  inheritSettings(program);
  return program;
}

/** `addCommand` does not copy output and exit settings to subcommands; do it once, recursively. */
function inheritSettings(parent: Command): void {
  for (const child of parent.commands) {
    child.copyInheritedSettings(parent);
    inheritSettings(child);
  }
}

function isEntry(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  await buildProgram().parseAsync(process.argv);
}
