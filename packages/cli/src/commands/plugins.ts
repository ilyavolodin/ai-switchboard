import { Command } from 'commander';

import { SDK_VERSION } from '@ai-switchboard/sdk';

import type { CliDeps } from '../deps.js';
import {
  homeDir,
  homeOption,
  jsonOption,
  printResult,
  type HomeFlags,
  type JsonFlags,
} from '../options.js';
import { fields, formatCapabilities, shortIntegrity, table } from '../output.js';
import { run } from './run.js';

function typesLine(types: { kind: string; typeId: string }[] | undefined): string {
  if (types === undefined) return '(unknown)';
  if (types.length === 0) return '(none)';
  return types.map((t) => `${t.kind} ${t.typeId}`).join(', ');
}

export function pluginsCommand(deps: CliDeps): Command {
  const { io } = deps;
  const plugins = new Command('plugins').description(
    'Install, remove, list and inspect plugin packages in $SWITCHBOARD_HOME/plugins',
  );

  jsonOption(
    homeOption(
      plugins
        .command('add')
        .argument('<spec>', 'npm spec, e.g. @acme/switchboard-source-jira@^1')
        .description('Install a plugin package and print its declared capabilities for review'),
    ).option('--allow-source', 'read capabilities from switchboard.source when entry is missing'),
  ).action(
    run(deps, async (spec: string, opts: HomeFlags & JsonFlags & { allowSource?: boolean }) => {
      const home = homeDir(opts, deps.env);
      const result = await deps.installer.install({
        home,
        spec,
        allowSource: opts.allowSource === true,
      });
      printResult(io, opts, result, () => {
        io.out(`Installed ${result.name} ${result.version} into ${home}/plugins`);
        io.out(
          fields([
            ['integrity', result.integrity ?? '(none: installed from a local directory)'],
            [
              'sdk range',
              `${result.sdkRange} (${result.compatible ? 'compatible with' : 'NOT compatible with'} SDK ${SDK_VERSION})`,
            ],
            [
              'plugin',
              result.plugin
                ? `${result.plugin.pluginId} — ${result.plugin.displayName}`
                : '(unknown)',
            ],
            ['types', typesLine(result.plugin?.types)],
          ]),
        );
        io.out('');
        io.out('Declared capabilities (review before restarting):');
        io.out(formatCapabilities(result.capabilities));
        for (const w of result.warnings) io.err(`warning: ${w}`);
        io.out('');
        io.out(
          'Pinned in plugins.lock.json. The server loads it on its next start: restart Switchboard to apply.',
        );
      });
    }),
  );

  homeOption(
    plugins
      .command('remove')
      .argument('<name>', 'package name, e.g. @acme/switchboard-source-jira')
      .description('Uninstall a plugin package and drop it from plugins.lock.json'),
  ).action(
    run(deps, async (name: string, opts: HomeFlags) => {
      const home = homeDir(opts, deps.env);
      await deps.installer.remove({ home, name });
      io.out(
        `Removed ${name}. Restart Switchboard to apply; its instances show as needing the plugin.`,
      );
    }),
  );

  jsonOption(
    homeOption(
      plugins.command('list').description('List installed plugins from plugins.lock.json'),
    ),
    'the lockfile entries',
  ).action(
    run(deps, async (opts: HomeFlags & JsonFlags) => {
      const home = homeDir(opts, deps.env);
      const installed = await deps.installer.list(home);
      printResult(io, opts, installed, () => {
        if (installed.length === 0) {
          io.out(
            `No plugins installed in ${home}/plugins (the image's baked-in plugins are not listed).`,
          );
          return;
        }
        io.out(
          table(
            ['NAME', 'VERSION', 'SDK', 'INSTALLED', 'INTEGRITY'],
            installed.map((p) => [
              p.name,
              p.version,
              p.sdk,
              p.installedAt,
              shortIntegrity(p.integrity),
            ]),
          ),
        );
      });
    }),
  );

  jsonOption(
    plugins
      .command('inspect')
      .argument('<spec>', 'npm spec, e.g. @acme/switchboard-source-jira@1.2.0')
      .description('Read a plugin package manifest from the registry without installing it'),
  ).action(
    run(deps, async (spec: string, opts: JsonFlags) => {
      const result = await deps.installer.inspect({ spec });
      printResult(io, opts, result, () => {
        io.out(`${result.name} ${result.version}`);
        io.out(
          fields([
            ['integrity', result.integrity ?? '-'],
            ['sdk range', result.sdkRange],
            [
              'compatible',
              result.compatible ? `yes (SDK ${SDK_VERSION})` : `no (SDK ${SDK_VERSION})`,
            ],
            ['types', typesLine(result.plugin?.types)],
          ]),
        );
        io.out('Declared capabilities:');
        io.out(formatCapabilities(result.capabilities));
        for (const w of result.warnings) io.err(`warning: ${w}`);
      });
      if (!result.compatible) io.setExitCode(1);
    }),
  );

  return plugins;
}
