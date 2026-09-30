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

export interface RecoveryRequest {
  email: string;
  password?: string;
  actor: string;
  reason: string;
}

/** Each call opens and closes its own pool, so the CLI needs no running server and no sign-in. */
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

export function accountRecovery(clock: Clock = systemClock): AccountRecovery {
  const input = (r: RecoveryRequest) => ({
    email: r.email,
    ...(r.password !== undefined ? { password: r.password } : {}),
    meta: { actor: r.actor, reason: r.reason, now: clock.now() },
  });
  return {
    listUsers: (config) => withDb(config, listAccounts),
    resetPassword: (config, r) => withDb(config, (db) => resetPassword(db, input(r))),
    createAdmin: (config, r) => withDb(config, (db) => createAdmin(db, input(r))),
  };
}
