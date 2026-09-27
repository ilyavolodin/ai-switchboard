import { Command, InvalidArgumentError } from 'commander';

import type { CliDeps } from '../deps.js';
import { run } from './run.js';

function port(value: string): string {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65_535) {
    throw new InvalidArgumentError('must be a port number');
  }
  return String(n);
}

/** `switchboard serve`: start the server (`node <@ai-switchboard/core>/dist/main.js`). */
export function serveCommand(deps: CliDeps): Command {
  return new Command('serve')
    .description(
      'Start the Switchboard server with the current environment (DATABASE_URL, PORT, ...)',
    )
    .option('-p, --port <port>', 'listen port (sets PORT)', port)
    .option('--home <dir>', 'sets SWITCHBOARD_HOME')
    .action(
      run(deps, async (opts: { port?: string; home?: string }) => {
        const entry = await deps.resolveServerEntry();
        const env: NodeJS.ProcessEnv = { ...deps.env };
        if (opts.port !== undefined) env.PORT = opts.port;
        if (opts.home !== undefined) env.SWITCHBOARD_HOME = opts.home;
        const code = await deps.spawnServer(entry, env);
        if (code !== 0) deps.io.setExitCode(code);
      }),
    );
}
