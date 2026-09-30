import { Command } from 'commander';

import type { CliDeps } from '../deps.js';
import { jsonOption, printResult, type JsonFlags } from '../options.js';
import { checkLine } from '../output.js';
import { run } from './run.js';

/** The server's own checks, run locally with the same environment. */
export function doctorCommand(deps: CliDeps): Command {
  return jsonOption(
    new Command('doctor').description(
      'Check the database, migrations, plugin manifests, secret resolution and every instance’s health (uses the server’s environment: DATABASE_URL, SWITCHBOARD_HOME, ...)',
    ),
    'the checks',
  ).action(
    run(deps, async (opts: JsonFlags) => {
      const checks = await deps.runDoctor(await deps.loadConfig(deps.env));
      const failed = checks.filter((c) => !c.ok);
      printResult(deps.io, opts, checks, () => {
        for (const c of checks) deps.io.out(checkLine(c.ok, c.name, c.detail));
        deps.io.out(
          failed.length === 0
            ? `All ${checks.length} checks passed.`
            : `${failed.length} of ${checks.length} checks failed.`,
        );
      });
      if (failed.length > 0) deps.io.setExitCode(1);
    }),
  );
}
