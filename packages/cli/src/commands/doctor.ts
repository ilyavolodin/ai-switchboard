import { Command } from 'commander';

import type { CliDeps } from '../deps.js';
import { checkLine } from '../output.js';
import { run } from './run.js';

/** `switchboard doctor`: the server's own checks, run locally with the same environment. */
export function doctorCommand(deps: CliDeps): Command {
  return new Command('doctor')
    .description(
      'Check the database, migrations, plugin manifests, secret resolution and every instance’s health (uses the server’s environment: DATABASE_URL, SWITCHBOARD_HOME, ...)',
    )
    .option('--json', 'print the checks as JSON')
    .action(
      run(deps, async (opts: { json?: boolean }) => {
        const checks = await deps.runDoctor(await deps.loadConfig(deps.env));
        const failed = checks.filter((c) => !c.ok);
        if (opts.json === true) {
          deps.io.out(JSON.stringify(checks, null, 2));
        } else {
          for (const c of checks) deps.io.out(checkLine(c.ok, c.name, c.detail));
          deps.io.out(
            failed.length === 0
              ? `All ${checks.length} checks passed.`
              : `${failed.length} of ${checks.length} checks failed.`,
          );
        }
        if (failed.length > 0) deps.io.setExitCode(1);
      }),
    );
}
