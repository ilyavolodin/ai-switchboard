import { systemClock, type Clock } from './clock.js';
import type { CoreConfig } from './config.js';
import { connect, type Db } from './db/client.js';
import {
  createAdmin,
  listAccounts,
  resetPassword,
  type AccountSummary,
  type TemporaryPasswordResult,
} from './services/recovery.js';

/** What the CLI passes for a reset or a break-glass admin; the core adds the time. */
export interface RecoveryRequest {
  email: string;
  password?: string;
  actor: string;
  reason: string;
}

/**
 * Account recovery against the server's database (`switchboard users list|reset-password|
 * create-admin`). Each call opens a small pool from `config.databaseUrl` and closes it, so the
 * CLI needs no running server and nobody signed in.
 */
export interface AccountRecovery {
  listUsers(config: CoreConfig): Promise<AccountSummary[]>;
  resetPassword(config: CoreConfig, request: RecoveryRequest): Promise<TemporaryPasswordResult>;
  createAdmin(config: CoreConfig, request: RecoveryRequest): Promise<TemporaryPasswordResult>;
}

async function withDb<T>(config: CoreConfig, fn: (db: Db) => Promise<T>): Promise<T> {
  const database = connect(config.databaseUrl, { max: 2 });
  try {
    return await fn(database.db);
  } finally {
    await database.close();
  }
}

/** The recovery functions bound to a real database; `clock` is for tests. */
export function accountRecovery(clock: Clock = systemClock): AccountRecovery {
  const input = (r: RecoveryRequest) => ({
    email: r.email,
    ...(r.password !== undefined ? { password: r.password } : {}),
    audit: { actor: r.actor, reason: r.reason, at: clock.now() },
  });
  return {
    listUsers: (config) => withDb(config, listAccounts),
    resetPassword: (config, r) => withDb(config, (db) => resetPassword(db, input(r))),
    createAdmin: (config, r) => withDb(config, (db) => createAdmin(db, input(r))),
  };
}
