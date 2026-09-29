import { Command } from 'commander';
import { parseDocument } from 'yaml';

import type { ApplyRequest, ApplyResponse } from '@ai-switchboard/core/contract';

import { apiRequest, DEFAULT_URL, serverOptions } from '../api.js';
import type { CliDeps } from '../deps.js';
import { table } from '../output.js';
import { run } from './run.js';

interface ServerFlags {
  url?: string;
  token?: string;
}

export function serverFlags(cmd: Command): Command {
  return cmd
    .option('--url <url>', `server base URL (env SWITCHBOARD_URL, default ${DEFAULT_URL})`)
    .option('--token <token>', 'API token sent as Authorization: Bearer (env SWITCHBOARD_TOKEN)');
}

const MARK: Record<ApplyResponse['changes'][number]['action'], string> = {
  create: '+',
  update: '~',
  unchanged: '=',
  delete: '-',
};

/** Parse locally first so a syntax error names the line before anything reaches the server. */
function checkYaml(text: string, file: string): void {
  const doc = parseDocument(text);
  const first = doc.errors[0];
  if (first !== undefined) throw new Error(`${file}: ${first.message}`);
  const value: unknown = doc.toJS();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${file}: expected a mapping with apiVersion: switchboard/v1`);
  }
}

function isApplyResponse(value: unknown): value is ApplyResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { changes?: unknown }).changes) &&
    Array.isArray((value as { errors?: unknown }).errors)
  );
}

export function exportCommand(deps: CliDeps): Command {
  return serverFlags(
    new Command('export')
      .description('Download the whole configuration as YAML (secret references, never values)')
      .option('-o, --output <file>', 'write to a file instead of stdout'),
  ).action(
    run(deps, async (opts: ServerFlags & { output?: string }) => {
      const server = serverOptions(opts, deps.env);
      const yaml = await apiRequest(deps, server, 'GET', '/export', {
        accept: 'text/yaml, application/yaml;q=0.9, */*;q=0.1',
      });
      if (opts.output !== undefined) {
        await deps.writeFile(opts.output, yaml);
        deps.io.err(`Wrote ${opts.output}`);
      } else {
        deps.io.out(yaml);
      }
    }),
  );
}

/** The server decides whether a reason is required (`requireReasons`) and answers 400 without one. */
export function applyCommand(deps: CliDeps): Command {
  return serverFlags(
    new Command('apply')
      .description('Apply a YAML configuration (one transaction, audited with the reason)')
      .requiredOption('-f, --file <file>', 'the YAML configuration to apply')
      .option(
        '--reason <text>',
        'one-line reason recorded in the audit log (required unless the server makes reasons optional)',
      )
      .option('--dry-run', 'validate and list the changes without writing anything'),
  ).action(
    run(deps, async (opts: ServerFlags & { file: string; reason?: string; dryRun?: boolean }) => {
      const text = await deps.readFile(opts.file);
      checkYaml(text, opts.file);
      const server = serverOptions(opts, deps.env);
      const request: ApplyRequest = {
        yaml: text,
        reason: opts.reason?.trim() ?? '',
        ...(opts.dryRun === true ? { dryRun: true } : {}),
      };
      const answer = await apiRequest(deps, server, 'POST', '/apply', { json: request });
      let body: unknown;
      try {
        body = JSON.parse(answer);
      } catch {
        throw new Error(`${server.url} returned a non-JSON answer to POST /apply; is --url right?`);
      }
      if (!isApplyResponse(body)) throw new Error('the server returned an unexpected response');

      const { io } = deps;
      io.out(
        body.dryRun
          ? `Dry run against ${server.url}: nothing was written.`
          : body.errors.length > 0
            ? `Not applied to ${server.url}: the errors below rolled the whole change back.`
            : `Applied to ${server.url}.`,
      );
      if (body.changes.length > 0) {
        io.out(
          table(
            ['', 'ACTION', 'KIND', 'NAME'],
            body.changes.map((c) => [MARK[c.action], c.action, c.kind, c.name]),
          ),
        );
      }
      const count = (a: string): number => body.changes.filter((c) => c.action === a).length;
      io.out(
        `${count('create')} to create, ${count('update')} to update, ${count('delete')} to delete, ${count('unchanged')} unchanged.`,
      );
      if (body.errors.length > 0) {
        io.err(`${body.errors.length} error(s):`);
        for (const e of body.errors) io.err(`  ✗ ${e}`);
        io.setExitCode(1);
      }
    }),
  );
}
