import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { constants, hostname } from 'node:os';

import type * as CoreModule from '@ai-switchboard/core';
import type {
  AccountRecovery,
  CoreConfig,
  DoctorCheck,
  InspectOptions,
  InspectResult,
  InstalledPlugin,
  InstallOptions,
  InstallResult,
  RemoveOptions,
} from '@ai-switchboard/core';

import { resolveServerEntry } from './serve-entry.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  setExitCode(code: number): void;
  /** All of stdin as UTF-8, for `--password-stdin`. */
  readStdin(): Promise<string>;
}

export interface Installer {
  install(options: InstallOptions): Promise<InstallResult>;
  remove(options: RemoveOptions): Promise<void>;
  list(home: string): Promise<InstalledPlugin[]>;
  inspect(options: InspectOptions): Promise<InspectResult>;
}

export interface CliDeps {
  io: CliIO;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  installer: Installer;
  loadConfig(env: NodeJS.ProcessEnv): Promise<CoreConfig>;
  runDoctor(config: CoreConfig): Promise<DoctorCheck[]>;
  /** Resolves with the child's exit code. */
  spawnServer(entry: string, env: NodeJS.ProcessEnv): Promise<number>;
  resolveServerEntry(): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Talks straight to the server's database, not the API. */
  recovery: AccountRecovery;
  /** For the `cli@<hostname>` audit actor. */
  hostname(): string;
}

const core = (): Promise<typeof CoreModule> => import('@ai-switchboard/core');

/** As a shell reports it: the code, or 128 + the signal number. */
export function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + constants.signals[signal];
  return 1;
}

function spawnNode(entry: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: 'inherit', env });
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(childExitCode(code, signal));
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function defaultDeps(): CliDeps {
  return {
    io: {
      out: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
      err: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
      setExitCode: (code) => {
        process.exitCode = code;
      },
      readStdin,
    },
    env: process.env,
    fetch: globalThis.fetch.bind(globalThis),
    // The core is imported lazily: commands that only talk to the API (and tests that inject
    // their own deps) never load the server's modules.
    installer: {
      install: async (o) => (await core()).installPlugin(o),
      remove: async (o) => (await core()).removePlugin(o),
      list: async (home) => (await core()).listInstalled(home),
      inspect: async (o) => (await core()).inspectPlugin(o),
    },
    loadConfig: async (env) => (await core()).loadConfig(env),
    runDoctor: async (config) => (await core()).runDoctor(config),
    spawnServer: spawnNode,
    resolveServerEntry: () => resolveServerEntry(import.meta.resolve('@ai-switchboard/core')),
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, content) => writeFile(path, content, 'utf8'),
    recovery: {
      listUsers: async (config) => (await core()).accountRecovery().listUsers(config),
      resetPassword: async (config, r) => (await core()).accountRecovery().resetPassword(config, r),
      createAdmin: async (config, r) => (await core()).accountRecovery().createAdmin(config, r),
    },
    hostname,
  };
}
