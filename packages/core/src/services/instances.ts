import { randomUUID } from 'node:crypto';

import type { ProvisionResult } from '@ai-switchboard/sdk';
import { eq, sql, type SQL } from 'drizzle-orm';

import type { ResultResponse } from '../contract/index.js';
import type { Db, DbOrTx } from '../db/client.js';
import { INSTANCE_TABLES, type InstanceTable } from '../db/instance-tables.js';
import { destinations, instanceState, notifiers, secretProviders, sources } from '../db/schema.js';
import type { InstanceKind } from '../domain/status.js';
import type { PluginAdminPort } from '../plugins/admin-port.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import { canonical } from '../util/canonical.js';
import { auditChange, recordAuditDiff, type ChangeMeta } from './audit.js';
import { conflict, notFound, unprocessable } from './errors.js';
import {
  checkableSchema,
  instanceName,
  instanceType,
  kindLabel,
  sourceAuthCaps,
  validateCaps,
  validateSettings,
} from './instance-validation.js';
import { callPlugin } from './pipeline/plugin-call.js';
import { processesUsing } from './process-refs.js';
import { providerUsers } from './secret-users.js';

export interface InstanceHead {
  id: string;
  typeId: string;
  name: string;
  enabled: boolean;
}

/** An instance row with the columns every kind shares; `caps` and `targetDefaults` are `{}` where a kind has none. */
export interface InstanceRecord extends InstanceHead {
  settings: Record<string, unknown>;
  caps: Record<string, unknown>;
  targetDefaults: Record<string, unknown>;
}

/** What instance writes need of the plugin host: the preview builder and the rebuild of dependents. */
export type InstanceHost = Pick<PluginAdminPort, 'buildPreviewSource' | 'reloadDependentsOf'>;

export interface InstanceDeps {
  db: Db;
  runtime: PluginRuntime;
  host: InstanceHost;
}

export interface InstanceDraft {
  typeId: string;
  name: string;
  settings: Record<string, unknown>;
  enabled?: boolean | undefined;
  caps?: Record<string, unknown> | undefined;
  targetDefaults?: Record<string, unknown> | undefined;
}

export interface InstancePatch {
  name?: string | undefined;
  settings?: Record<string, unknown> | undefined;
  caps?: Record<string, unknown> | undefined;
  targetDefaults?: Record<string, unknown> | undefined;
}

export const LABELS: Readonly<Record<InstanceKind, string>> = {
  source: 'Source',
  destination: 'Destination',
  notifier: 'Notifier',
  secret_provider: 'Secret provider',
};

/** The columns a kind has beyond the ones every instance table shares. */
export const INSTANCE_COLUMNS: Readonly<
  Record<InstanceKind, { caps: boolean; targetDefaults: boolean }>
> = {
  source: { caps: true, targetDefaults: false },
  destination: { caps: true, targetDefaults: true },
  notifier: { caps: false, targetDefaults: false },
  secret_provider: { caps: false, targetDefaults: false },
};

/**
 * Set in every write that changes what the live object is built from (name, settings, enabled),
 * so every replica rebuilds it on its next reconcile pass.
 */
export function nextConfigVersion(t: InstanceTable): SQL {
  return sql`${t.configVersion} + 1`;
}

function probeOf(host: InstanceHost): PluginAdminPort['buildPreviewSource'] {
  return (typeId, settings, id, name) => host.buildPreviewSource(typeId, settings, id, name);
}

export async function findInstance(
  db: DbOrTx,
  kind: InstanceKind,
  id: string,
): Promise<InstanceHead | undefined> {
  const t = INSTANCE_TABLES[kind];
  const [row] = await db
    .select({ id: t.id, typeId: t.typeId, name: t.name, enabled: t.enabled })
    .from(t)
    .where(eq(t.id, id));
  return row;
}

async function loadRecord(
  db: DbOrTx,
  kind: InstanceKind,
  id: string,
  lock: boolean,
): Promise<InstanceRecord | undefined> {
  const t = INSTANCE_TABLES[kind];
  const query = db.select().from(t).where(eq(t.id, id));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) return undefined;
  const columns = INSTANCE_COLUMNS[kind];
  return {
    id: row.id,
    typeId: row.typeId,
    name: row.name,
    enabled: row.enabled,
    settings: row.settings,
    caps: columns.caps && 'caps' in row ? { ...row.caps } : {},
    targetDefaults:
      columns.targetDefaults && 'targetDefaults' in row ? { ...row.targetDefaults } : {},
  };
}

export async function loadInstance(
  db: DbOrTx,
  kind: InstanceKind,
  id: string,
): Promise<InstanceRecord> {
  const row = await loadRecord(db, kind, id, false);
  if (!row) throw notFound(LABELS[kind]);
  return row;
}

/** What an audit row records of an instance: never more than the settings (which hold references). */
function auditView(kind: InstanceKind, r: Omit<InstanceRecord, 'id' | 'enabled'>) {
  return {
    name: r.name,
    typeId: r.typeId,
    settings: r.settings,
    ...(INSTANCE_COLUMNS[kind].caps ? { caps: r.caps } : {}),
  };
}

function prefix(name: string, obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[`${name}.${k}`] = v;
  return out;
}

/** Flattened for field-level audit rows: `settings.url`, `caps.runsPerDay`. */
function diffView(kind: InstanceKind, r: InstanceRecord): Record<string, unknown> {
  const columns = INSTANCE_COLUMNS[kind];
  return {
    name: r.name,
    enabled: r.enabled,
    ...prefix('settings', r.settings),
    ...(columns.caps ? prefix('caps', r.caps) : {}),
    ...(columns.targetDefaults ? { targetDefaults: r.targetDefaults } : {}),
  };
}

/** Validates a new instance and derives what the row stores. Throws a `DomainError` to refuse. */
export async function checkNewInstance(
  deps: Pick<InstanceDeps, 'runtime' | 'host'>,
  kind: InstanceKind,
  id: string,
  draft: InstanceDraft,
): Promise<InstanceRecord> {
  const type = instanceType(deps.runtime, kind, draft.typeId);
  if (!type)
    throw unprocessable(`No installed plugin provides ${kindLabel(kind)} type "${draft.typeId}".`);
  const settings = validateSettings(type.settingsSchema, draft.settings);
  const name = instanceName(kind, draft.name);
  let caps = validateCaps(kind, draft.caps);
  if (kind === 'source')
    caps = await sourceAuthCaps(
      deps.runtime,
      probeOf(deps.host),
      { id, typeId: draft.typeId, name, settings },
      caps,
      false,
    );
  return {
    id,
    typeId: draft.typeId,
    name,
    enabled: draft.enabled ?? true,
    settings,
    caps,
    targetDefaults: INSTANCE_COLUMNS[kind].targetDefaults ? (draft.targetDefaults ?? {}) : {},
  };
}

/** Validates a change against the stored row and returns the row as it will be. */
export async function checkInstanceChange(
  deps: Pick<InstanceDeps, 'runtime' | 'host'>,
  kind: InstanceKind,
  before: InstanceRecord,
  patch: InstancePatch,
): Promise<InstanceRecord> {
  const type = instanceType(deps.runtime, kind, before.typeId);
  const settings = patch.settings
    ? validateSettings(checkableSchema(type), patch.settings)
    : before.settings;
  const name = patch.name !== undefined ? instanceName(kind, patch.name) : before.name;
  let caps = patch.caps ? validateCaps(kind, patch.caps) : before.caps;
  if (kind === 'source')
    caps = await sourceAuthCaps(
      deps.runtime,
      probeOf(deps.host),
      { id: before.id, typeId: before.typeId, name, settings },
      caps,
      before.caps.unauthenticated === true,
    );
  return {
    ...before,
    name,
    settings,
    caps,
    targetDefaults: INSTANCE_COLUMNS[kind].targetDefaults
      ? (patch.targetDefaults ?? before.targetDefaults)
      : {},
  };
}

async function insertRecord(
  tx: DbOrTx,
  kind: InstanceKind,
  r: InstanceRecord,
  now: Date,
): Promise<void> {
  const common = {
    id: r.id,
    typeId: r.typeId,
    name: r.name,
    settings: r.settings,
    enabled: r.enabled,
    createdAt: now,
    updatedAt: now,
  };
  switch (kind) {
    case 'source':
      await tx.insert(sources).values({ ...common, caps: r.caps });
      return;
    case 'destination':
      await tx
        .insert(destinations)
        .values({ ...common, caps: r.caps, targetDefaults: r.targetDefaults });
      return;
    case 'notifier':
      await tx.insert(notifiers).values(common);
      return;
    case 'secret_provider':
      await tx.insert(secretProviders).values(common);
      return;
  }
}

async function updateRecord(
  tx: DbOrTx,
  kind: InstanceKind,
  r: InstanceRecord,
  now: Date,
): Promise<void> {
  const t = INSTANCE_TABLES[kind];
  const columns = INSTANCE_COLUMNS[kind];
  await tx
    .update(t)
    .set({
      name: r.name,
      settings: r.settings,
      enabled: r.enabled,
      updatedAt: now,
      configVersion: nextConfigVersion(t),
      ...(columns.caps ? { caps: r.caps } : {}),
      ...(columns.targetDefaults ? { targetDefaults: r.targetDefaults } : {}),
    })
    .where(eq(t.id, r.id));
}

/** Inside the caller's transaction (YAML apply); the record was checked by `checkNewInstance`. */
export async function insertInstance(
  tx: DbOrTx,
  kind: InstanceKind,
  record: InstanceRecord,
  meta: ChangeMeta,
): Promise<void> {
  await insertRecord(tx, kind, record, meta.now);
  await auditChange(tx, meta, {
    scope: kind,
    targetId: record.id,
    field: 'created',
    after: auditView(kind, record),
  });
}

/** Inside the caller's transaction; one audit row per changed field. */
export async function writeInstanceChange(
  tx: DbOrTx,
  kind: InstanceKind,
  before: InstanceRecord,
  after: InstanceRecord,
  meta: ChangeMeta,
): Promise<void> {
  await updateRecord(tx, kind, after, meta.now);
  await recordAuditDiff(
    tx,
    { actor: meta.actor, scope: kind, targetId: before.id, reason: meta.reason, at: meta.now },
    diffView(kind, before),
    diffView(kind, after),
  );
}

/**
 * This replica rebuilds the live instance at once (the others on their reconcile pass). A secret
 * provider's instances resolve their secrets when built, so a change to one rebuilds the
 * instances that reference `providerNames` too.
 */
async function rebuild(
  deps: Pick<InstanceDeps, 'runtime' | 'host'>,
  kind: InstanceKind,
  id: string,
  providerNames: readonly string[] = [],
): Promise<void> {
  await deps.runtime.reload(kind, id);
  if (kind === 'secret_provider' && providerNames.length > 0) {
    await deps.host.reloadDependentsOf([...new Set(providerNames)]);
  }
}

export async function createInstance(
  deps: InstanceDeps,
  kind: InstanceKind,
  draft: InstanceDraft,
  meta: ChangeMeta,
): Promise<InstanceRecord> {
  const record = await checkNewInstance(deps, kind, randomUUID(), draft);
  await deps.db.transaction((tx) => insertInstance(tx, kind, record, meta));
  // References to this name that failed before the provider existed resolve now.
  await rebuild(deps, kind, record.id, [record.name]);
  return record;
}

const SAME_ROW_ATTEMPTS = 3;

/**
 * The change is checked outside the transaction (building a source may reach its backend), then
 * written only if the row is still what it was checked against; otherwise it is checked again
 * against the newer row, so a concurrent change is kept, not overwritten. Returns the row
 * before and after, and rebuilds what the change affects.
 */
export async function updateInstance(
  deps: InstanceDeps,
  kind: InstanceKind,
  id: string,
  patch: InstancePatch,
  meta: ChangeMeta,
): Promise<{ before: InstanceRecord; after: InstanceRecord }> {
  let before = await loadInstance(deps.db, kind, id);
  for (let attempt = 0; attempt < SAME_ROW_ATTEMPTS; attempt++) {
    const after = await checkInstanceChange(deps, kind, before, patch);
    const moved = await deps.db.transaction(async (tx) => {
      const current = await loadRecord(tx, kind, id, true);
      if (!current) throw notFound(LABELS[kind]);
      if (canonical(current) !== canonical(before)) return current;
      await writeInstanceChange(tx, kind, current, after, meta);
      return null;
    });
    if (moved === null) {
      // After a rename, instances still naming the old provider fail with a secret_error;
      // nothing rewrites their references.
      await rebuild(deps, kind, after.id, [before.name, after.name]);
      return { before, after };
    }
    before = moved;
  }
  throw conflict(`The ${kindLabel(kind)} keeps changing under this edit; reload and try again.`);
}

export async function setInstanceEnabled(
  deps: InstanceDeps,
  kind: InstanceKind,
  id: string,
  enabled: boolean,
  meta: ChangeMeta,
): Promise<InstanceHead> {
  const t = INSTANCE_TABLES[kind];
  const row = await deps.db.transaction(async (tx) => {
    const before = await loadRecord(tx, kind, id, true);
    if (!before) throw notFound(LABELS[kind]);
    await tx
      .update(t)
      .set({ enabled, updatedAt: meta.now, configVersion: nextConfigVersion(t) })
      .where(eq(t.id, id));
    await auditChange(tx, meta, {
      scope: kind,
      targetId: id,
      field: 'enabled',
      before: before.enabled,
      after: enabled,
    });
    return before;
  });
  await rebuild(deps, kind, row.id, [row.name]);
  return row;
}

/**
 * For an explicit reload, e.g. after a secret rotated in the backend. The version bump makes the
 * other replicas rebuild it too. A destination's "unhealthy" mark (set after a 401/403) is
 * cleared; the next health check re-evaluates it.
 */
export async function requestInstanceReload(
  deps: InstanceDeps,
  kind: InstanceKind,
  id: string,
  meta: ChangeMeta,
): Promise<InstanceHead> {
  const t = INSTANCE_TABLES[kind];
  const row = await deps.db.transaction(async (tx) => {
    const current = await loadRecord(tx, kind, id, true);
    if (!current) throw notFound(LABELS[kind]);
    if (kind === 'destination')
      await tx.update(destinations).set({ health: null }).where(eq(destinations.id, id));
    await tx
      .update(t)
      .set({ configVersion: nextConfigVersion(t) })
      .where(eq(t.id, id));
    await auditChange(tx, meta, { scope: kind, targetId: id, field: 'reload' });
    return current;
  });
  await rebuild(deps, kind, row.id, [row.name]);
  return row;
}

async function refuseDeleteInUse(tx: DbOrTx, kind: InstanceKind, row: InstanceHead): Promise<void> {
  if (kind === 'secret_provider') {
    const users = await providerUsers(tx, row.name, row.id);
    if (users.length > 0)
      throw conflict(
        `Still used by ${users.map((u) => `${kindLabel(u.kind)} "${u.name}"`).join(', ')}. Point their secret://${row.name}/… references at another provider first.`,
      );
    return;
  }
  const users = await processesUsing(tx, row.id);
  if (users.length === 0) return;
  const hint =
    kind === 'source'
      ? ' Remove it from those processes first.'
      : kind === 'destination'
        ? ' Bind those processes elsewhere first.'
        : '';
  throw conflict(`Still used by ${users.map((u) => u.name).join(', ')}.${hint}`, users);
}

/** Refused with a 409 naming who still uses it. The state its plugin kept goes with it. */
export async function deleteInstance(
  deps: Pick<InstanceDeps, 'db' | 'runtime'>,
  kind: InstanceKind,
  id: string,
  meta: ChangeMeta,
): Promise<InstanceHead> {
  const t = INSTANCE_TABLES[kind];
  const row = await deps.db.transaction(async (tx) => {
    const current = await loadRecord(tx, kind, id, true);
    if (!current) throw notFound(LABELS[kind]);
    await refuseDeleteInUse(tx, kind, current);
    await tx.delete(t).where(eq(t.id, id));
    await tx.delete(instanceState).where(eq(instanceState.instanceId, id));
    await auditChange(tx, meta, {
      scope: kind,
      targetId: id,
      field: 'deleted',
      before: { name: current.name, typeId: current.typeId },
    });
    return current;
  });
  await deps.runtime.reload(kind, row.id);
  return row;
}

/** Asks a push source's plugin to register its webhook at `url`. */
export async function provisionSource(
  deps: Pick<InstanceDeps, 'db' | 'runtime'>,
  id: string,
  url: string,
  meta: ChangeMeta,
): Promise<ResultResponse> {
  const live = deps.runtime.source(id);
  if (!live) throw notFound('Running source');
  const provision = live.source.provision?.bind(live.source);
  if (!provision) throw unprocessable(`${live.type.displayName} cannot register webhooks itself.`);
  const out = await callPlugin('provision', () => provision(url));
  const result: ProvisionResult = out.ok ? out.value : { ok: false, message: out.error };
  await deps.db.transaction(async (tx) => {
    if (result.ok)
      await tx.update(sources).set({ provisionedAt: meta.now }).where(eq(sources.id, live.id));
    await auditChange(tx, meta, {
      scope: 'source',
      targetId: live.id,
      field: 'provision',
      after: result,
    });
  });
  return {
    ok: result.ok,
    message:
      result.message ?? (result.ok ? `Webhook registered for ${url}` : 'Registration failed'),
  };
}

/** The attempt is audited before the send, so a notifier that hangs still leaves a trace. */
export async function sendTestNotification(
  deps: Pick<InstanceDeps, 'db' | 'runtime'>,
  id: string,
  meta: ChangeMeta,
): Promise<ResultResponse> {
  const live = deps.runtime.notifier(id);
  if (!live) throw notFound('Running notifier');
  await auditChange(deps.db, meta, { scope: 'notifier', targetId: live.id, field: 'test_sent' });
  const out = await callPlugin('send', () =>
    live.notifier.send({
      on: 'system',
      severity: 'info',
      title: 'Switchboard test notification',
      text: `Sent by ${meta.actor}: ${meta.reason}`,
    }),
  );
  return out.ok ? { ok: true, message: 'Sent.' } : { ok: false, message: out.error };
}
