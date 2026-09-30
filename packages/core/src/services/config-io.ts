import { randomUUID } from 'node:crypto';

import { validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';
import { parse, stringify } from 'yaml';

import type { ApplyResponse } from '../contract/index.js';
import type { Clock } from '../clock.js';
import type { Db, DbOrTx, Tx } from '../db/client.js';
import { INSTANCE_TABLES, type InstanceTable } from '../db/instance-tables.js';
import { destinations, notifiers, processes, secretProviders, sources } from '../db/schema.js';
import type { ProcessDocument } from '../domain/process.js';
import { mergeSettings, type GlobalSettings } from '../domain/settings.js';
import type { InstanceKind } from '../domain/status.js';
import type { PluginAdminPort } from '../plugins/admin-port.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import { canonical } from '../util/canonical.js';
import { errorText } from '../util/errors.js';
import type { ChangeMeta } from './audit.js';
import { problemsOf } from './errors.js';
import { instanceType } from './instance-validation.js';
import {
  checkInstanceChange,
  checkNewInstance,
  insertInstance,
  loadInstance,
  writeInstanceChange,
  type InstanceDraft,
  type InstanceHost,
  type InstanceRecord,
} from './instances.js';
import { validateProcessDocument } from './process-validation.js';
import { insertProcess, saveProcessVersionIn } from './processes.js';
import { getSettings, writeSettings } from './settings.js';

/**
 * Instances are referenced by name inside processes so a file moves between installations.
 * Secret references stay intact; secret values never appear.
 */
export interface ConfigurationFile {
  apiVersion: 'switchboard/v1';
  kind: 'Configuration';
  settings?: Partial<Omit<GlobalSettings, 'oidc'>>;
  secretProviders?: InstanceSpec[];
  sources?: (InstanceSpec & { caps?: Record<string, unknown> })[];
  destinations?: (InstanceSpec & {
    caps?: Record<string, unknown>;
    targetDefaults?: Record<string, unknown>;
  })[];
  notifiers?: InstanceSpec[];
  processes?: PortableProcess[];
}

export interface InstanceSpec {
  name: string;
  type: string;
  enabled?: boolean;
  settings?: Record<string, unknown>;
}

export type PortableProcess = Omit<
  ProcessDocument,
  'triggers' | 'destination' | 'before' | 'after' | 'notify'
> & {
  triggers: (Omit<ProcessDocument['triggers'][number], 'sourceId'> & { source: string })[];
  destination: { instance: string; target: unknown };
  before: (Omit<ProcessDocument['before'][number], 'provider'> & { provider: string })[];
  after: (Omit<ProcessDocument['after'][number], 'provider'> & { provider: string })[];
  notify: (Omit<ProcessDocument['notify'][number], 'notifierId'> & { notifier: string })[];
};

const instanceSpecSchema: JSONSchema = {
  type: 'object',
  required: ['name', 'type'],
  properties: {
    name: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
    settings: { type: 'object' },
    caps: { type: 'object' },
    targetDefaults: { type: 'object' },
  },
};

const fileSchema: JSONSchema = {
  type: 'object',
  required: ['apiVersion', 'kind'],
  properties: {
    apiVersion: { const: 'switchboard/v1' },
    kind: { const: 'Configuration' },
    settings: { type: 'object' },
    secretProviders: { type: 'array', items: instanceSpecSchema },
    sources: { type: 'array', items: instanceSpecSchema },
    destinations: { type: 'array', items: instanceSpecSchema },
    notifiers: { type: 'array', items: instanceSpecSchema },
    processes: { type: 'array', items: { type: 'object', required: ['name'] } },
  },
};

/**
 * Accepts the pre-SDK-2.0 `executors:` list and process `executor:` binding; export writes only
 * the new names. Remove in a future major.
 */
export function upgradeLegacyConfiguration(file: unknown): { file: unknown; errors: string[] } {
  if (file === null || typeof file !== 'object' || Array.isArray(file)) return { file, errors: [] };
  const errors: string[] = [];
  const out: Record<string, unknown> = { ...(file as Record<string, unknown>) };
  if ('executors' in out) {
    if ('destinations' in out)
      errors.push('use either destinations or executors (deprecated), not both');
    else out.destinations = out.executors;
    delete out.executors;
  }
  if (Array.isArray(out.processes)) {
    out.processes = out.processes.map((p: unknown, i) => {
      if (p === null || typeof p !== 'object' || !('executor' in p)) return p;
      const { executor, ...rest } = p as Record<string, unknown>;
      if ('destination' in rest) {
        errors.push(`processes[${i}]: use either destination or executor (deprecated), not both`);
        return rest;
      }
      return { ...rest, destination: executor };
    });
  }
  return { file: out, errors };
}

/** Parses and checks the file's shape; `errors` when it cannot be applied at all. */
export function parseConfiguration(
  yamlText: string,
): { ok: true; file: ConfigurationFile } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    return { ok: false, errors: [`YAML: ${errorText(err)}`] };
  }
  const upgraded = upgradeLegacyConfiguration(raw);
  if (upgraded.errors.length > 0) return { ok: false, errors: upgraded.errors };
  const check = validateAgainst(fileSchema, upgraded.file);
  if (!check.valid) return { ok: false, errors: check.errors };
  return { ok: true, file: upgraded.file as ConfigurationFile };
}

/** A process document with instance ids replaced by names. */
export function toPortableProcess(
  d: ProcessDocument,
  nameOf: (id: string) => string,
): PortableProcess {
  return {
    ...d,
    triggers: d.triggers.map(({ sourceId, ...t }) => ({ ...t, source: nameOf(sourceId) })),
    destination: { instance: nameOf(d.destination.instanceId), target: d.destination.target },
    before: d.before.map((s) => ({ ...s, provider: nameOf(s.provider) })),
    after: d.after.map((s) => ({ ...s, provider: nameOf(s.provider) })),
    notify: d.notify.map(({ notifierId, ...n }) => ({ ...n, notifier: nameOf(notifierId) })),
  };
}

export interface NameResolver {
  source(name: string): string;
  destination(name: string): string;
  notifier(name: string): string;
  /** A step's provider: a source or a destination. */
  provider(name: string): string;
}

/** The inverse of `toPortableProcess`. YAML is untrusted input: every nested list may be missing. */
export function fromPortableProcess(
  p: Partial<PortableProcess> & { name: string },
  ids: NameResolver,
): unknown {
  return {
    ...p,
    triggers: (p.triggers ?? []).map(({ source, ...t }) => ({
      ...t,
      sourceId: ids.source(source),
    })),
    destination: {
      instanceId: ids.destination(p.destination?.instance ?? ''),
      target: p.destination?.target ?? {},
    },
    before: (p.before ?? []).map((s) => ({ ...s, provider: ids.provider(s.provider) })),
    after: (p.after ?? []).map((s) => ({ ...s, provider: ids.provider(s.provider) })),
    notify: (p.notify ?? []).map(({ notifier, ...n }) => ({
      ...n,
      notifierId: ids.notifier(notifier),
    })),
  };
}

interface InstanceRowLike {
  id: string;
  name: string;
  typeId: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

function specOf(r: InstanceRowLike): InstanceSpec {
  return { name: r.name, type: r.typeId, enabled: r.enabled, settings: r.settings };
}

export interface ConfigurationSnapshot {
  settings: GlobalSettings;
  secretProviders: InstanceRowLike[];
  sources: (InstanceRowLike & { caps: object })[];
  destinations: (InstanceRowLike & { caps: object; targetDefaults: Record<string, unknown> })[];
  notifiers: InstanceRowLike[];
  processes: { document: ProcessDocument }[];
}

/** The portable file for what is stored; OIDC settings stay behind. */
export function toConfigurationFile(s: ConfigurationSnapshot): ConfigurationFile {
  const names = new Map<string, string>();
  for (const r of [...s.sources, ...s.destinations, ...s.notifiers]) names.set(r.id, r.name);
  const nameOf = (id: string): string => names.get(id) ?? id;
  const { oidc: _oidc, ...portable } = s.settings;
  return {
    apiVersion: 'switchboard/v1',
    kind: 'Configuration',
    settings: {
      ...portable,
      systemNotifierId: portable.systemNotifierId ? nameOf(portable.systemNotifierId) : null,
      export: {
        ...portable.export,
        sourceId: portable.export.sourceId ? nameOf(portable.export.sourceId) : null,
      },
    },
    secretProviders: s.secretProviders.map(specOf),
    sources: s.sources.map((r) => ({ ...specOf(r), caps: { ...r.caps } })),
    destinations: s.destinations.map((r) => ({
      ...specOf(r),
      caps: { ...r.caps },
      targetDefaults: r.targetDefaults,
    })),
    notifiers: s.notifiers.map(specOf),
    processes: s.processes.map((p) => toPortableProcess(p.document, nameOf)),
  };
}

export async function exportConfiguration(db: DbOrTx): Promise<string> {
  const [settings, sp, src, ex, nt, procs] = await Promise.all([
    getSettings(db),
    db.select().from(secretProviders).orderBy(secretProviders.name),
    db.select().from(sources).orderBy(sources.name),
    db.select().from(destinations).orderBy(destinations.name),
    db.select().from(notifiers).orderBy(notifiers.name),
    db.select().from(processes).orderBy(processes.name),
  ]);
  const file = toConfigurationFile({
    settings,
    secretProviders: sp,
    sources: src,
    destinations: ex,
    notifiers: nt,
    processes: procs,
  });
  return stringify(file, { lineWidth: 120 });
}

export interface ApplyDeps {
  db: Db;
  runtime: PluginRuntime;
  clock: Clock;
  host: InstanceHost & Pick<PluginAdminPort, 'instantiateAll'>;
}

type Change = ApplyResponse['changes'][number];

type SpecOf<K extends InstanceKind> = K extends 'source'
  ? NonNullable<ConfigurationFile['sources']>[number]
  : K extends 'destination'
    ? NonNullable<ConfigurationFile['destinations']>[number]
    : InstanceSpec;

function draftOf(spec: InstanceSpec & { caps?: unknown; targetDefaults?: unknown }): InstanceDraft {
  return {
    typeId: spec.type,
    name: spec.name,
    settings: spec.settings ?? {},
    enabled: spec.enabled ?? true,
    caps: (spec.caps ?? {}) as Record<string, unknown>,
    targetDefaults: (spec.targetDefaults ?? {}) as Record<string, unknown>,
  };
}

/** What apply compares to tell an unchanged instance from a changed one. */
function comparable(r: InstanceRecord) {
  return {
    typeId: r.typeId,
    settings: r.settings,
    enabled: r.enabled,
    caps: r.caps,
    targetDefaults: r.targetDefaults,
  };
}

/** Collects what one apply changed and refused. */
interface ApplyLog {
  changes: Change[];
  errors: string[];
}

async function applyInstances<K extends InstanceKind>(
  deps: ApplyDeps,
  tx: Tx,
  meta: ChangeMeta,
  log: ApplyLog,
  kind: K,
  specs: SpecOf<K>[] | undefined,
): Promise<void> {
  const table: InstanceTable = INSTANCE_TABLES[kind];
  const existing = await tx.select({ id: table.id, name: table.name }).from(table);
  for (const spec of specs ?? []) {
    const where = `${kind} "${spec.name}"`;
    if (!instanceType(deps.runtime, kind, spec.type)) {
      log.errors.push(`${where}: no installed plugin provides type ${spec.type}`);
      continue;
    }
    const draft = draftOf(spec);
    const row = existing.find((r) => r.name === spec.name);
    try {
      if (!row) {
        const record = await checkNewInstance(deps, kind, randomUUID(), draft);
        await insertInstance(tx, kind, record, meta);
        log.changes.push({ kind, name: spec.name, action: 'create' });
        continue;
      }
      const before = await loadInstance(tx, kind, row.id);
      if (before.typeId !== spec.type) {
        log.errors.push(`${where} exists with type ${before.typeId}; a type cannot change`);
        continue;
      }
      const checked = await checkInstanceChange(deps, kind, before, draft);
      const after = { ...checked, enabled: draft.enabled ?? true };
      if (canonical(comparable(before)) === canonical(comparable(after))) {
        log.changes.push({ kind, name: spec.name, action: 'unchanged' });
        continue;
      }
      await writeInstanceChange(tx, kind, before, after, meta);
      log.changes.push({ kind, name: spec.name, action: 'update' });
    } catch (err) {
      log.errors.push(...problemsOf(err).map((p) => `${where}: ${p}`));
    }
  }
}

/** Instance ids by kind and name, including the ones this apply created. */
async function nameResolver(tx: Tx, log: ApplyLog): Promise<NameResolver> {
  const ids = new Map<string, string>();
  for (const kind of ['source', 'destination', 'notifier'] as const) {
    const table = INSTANCE_TABLES[kind];
    for (const r of await tx.select({ id: table.id, name: table.name }).from(table))
      ids.set(`${kind}:${r.name}`, r.id);
  }
  const idOf = (kind: string, name: string): string => {
    const id = ids.get(`${kind}:${name}`);
    if (id) return id;
    log.errors.push(`no ${kind} named "${name}"`);
    return '';
  };
  return {
    source: (name) => idOf('source', name),
    destination: (name) => idOf('destination', name),
    notifier: (name) => idOf('notifier', name),
    provider: (name) =>
      ids.get(`source:${name}`) ??
      ids.get(`destination:${name}`) ??
      idOf('source or destination', name),
  };
}

/** Errors a resolver logged while `fn` ran are prefixed with `where`. */
function within<T>(log: ApplyLog, where: string, fn: () => T): T {
  const from = log.errors.length;
  const out = fn();
  for (let i = from; i < log.errors.length; i++) log.errors[i] = `${where}: ${log.errors[i]}`;
  return out;
}

async function applySettings(
  tx: Tx,
  meta: ChangeMeta,
  log: ApplyLog,
  s: NonNullable<ConfigurationFile['settings']>,
  ids: NameResolver,
): Promise<void> {
  const current = await getSettings(tx);
  const next: GlobalSettings = {
    ...mergeSettings(current, s),
    oidc: current.oidc,
    export: {
      ...current.export,
      ...s.export,
      sourceId: s.export?.sourceId
        ? within(log, 'settings.export.sourceId', () => ids.source(s.export?.sourceId ?? ''))
        : current.export.sourceId,
    },
    systemNotifierId: s.systemNotifierId
      ? within(log, 'settings.systemNotifierId', () => ids.notifier(s.systemNotifierId ?? ''))
      : 'systemNotifierId' in s
        ? null
        : current.systemNotifierId,
  };
  if (canonical(next) === canonical(current)) {
    log.changes.push({ kind: 'settings', name: 'global', action: 'unchanged' });
    return;
  }
  await writeSettings(tx, current, next, meta);
  log.changes.push({ kind: 'settings', name: 'global', action: 'update' });
}

async function applyProcesses(
  deps: ApplyDeps,
  tx: Tx,
  meta: ChangeMeta,
  log: ApplyLog,
  list: (Partial<PortableProcess> & { name: string })[],
  ids: NameResolver,
): Promise<void> {
  const existing = await tx.select().from(processes);
  for (const p of list) {
    const where = `process "${p.name}"`;
    const draft = within(log, where, () => fromPortableProcess(p, ids));
    let doc: ProcessDocument;
    try {
      doc = await validateProcessDocument(deps, tx, draft);
    } catch (err) {
      log.errors.push(...problemsOf(err).map((m) => `${where}: ${m}`));
      continue;
    }
    const row = existing.find((r) => r.name === p.name);
    if (!row) {
      await insertProcess(tx, doc, meta);
      log.changes.push({ kind: 'process', name: p.name, action: 'create' });
    } else if (canonical(row.document) === canonical(doc)) {
      log.changes.push({ kind: 'process', name: p.name, action: 'unchanged' });
    } else {
      await saveProcessVersionIn(tx, row.id, meta, () => ({
        document: doc,
        audit: { field: 'applied', after: doc },
      }));
      log.changes.push({ kind: 'process', name: p.name, action: 'update' });
    }
  }
}

class Rollback extends Error {
  override readonly name = 'Rollback';
}

/**
 * One transaction, matched by name. Additive: nothing missing from the file is deleted. A dry run
 * rolls back. Instances and processes go through the same checks and writes as the API; after a
 * real apply every instance is rebuilt.
 */
export async function applyConfiguration(
  deps: ApplyDeps,
  yamlText: string,
  meta: ChangeMeta,
  dryRun: boolean,
): Promise<ApplyResponse> {
  const parsed = parseConfiguration(yamlText);
  if (!parsed.ok) return { dryRun, changes: [], errors: parsed.errors };
  const { file } = parsed;
  const log: ApplyLog = { changes: [], errors: [] };
  const applied: ChangeMeta = { ...meta, reason: `apply: ${meta.reason}` };

  try {
    await deps.db.transaction(async (tx) => {
      await applyInstances(deps, tx, applied, log, 'secret_provider', file.secretProviders);
      await applyInstances(deps, tx, applied, log, 'source', file.sources);
      await applyInstances(deps, tx, applied, log, 'destination', file.destinations);
      await applyInstances(deps, tx, applied, log, 'notifier', file.notifiers);
      const ids = await nameResolver(tx, log);
      if (file.settings) await applySettings(tx, applied, log, file.settings, ids);
      await applyProcesses(deps, tx, applied, log, file.processes ?? [], ids);
      if (dryRun || log.errors.length > 0) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  if (!dryRun && log.errors.length === 0) await deps.host.instantiateAll();
  return { dryRun, changes: log.changes, errors: log.errors };
}
