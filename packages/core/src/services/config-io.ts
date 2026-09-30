import { randomUUID } from 'node:crypto';

import { validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';
import { parse, stringify } from 'yaml';

import type { ApplyResponse } from '../contract/index.js';
import type { Clock } from '../clock.js';
import type { Db, DbOrTx } from '../db/client.js';
import { INSTANCE_TABLES, type InstanceTable } from '../db/instance-tables.js';
import { destinations, notifiers, processes, secretProviders, sources } from '../db/schema.js';
import type { ProcessDocument } from '../domain/process.js';
import { mergeSettings, type GlobalSettings } from '../domain/settings.js';
import type { InstanceKind } from '../domain/status.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import { errorText } from '../util/errors.js';
import { auditChange, type ChangeMeta } from './audit.js';
import { problemsOf } from './errors.js';
import { instanceType, type SourceProbe } from './instance-validation.js';
import {
  checkInstanceChange,
  checkNewInstance,
  insertInstance,
  loadInstance,
  writeInstanceChange,
  type InstanceDraft,
  type InstanceRecord,
} from './instances.js';
import { validateProcessDocument } from './process-validation.js';
import { insertProcess, saveProcessVersionIn } from './processes.js';
import { getSettings, putSettings } from './settings.js';

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

/** Key-order-independent JSON, because jsonb does not preserve key order. */
export function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, norm(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

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

export async function exportConfiguration(db: DbOrTx): Promise<string> {
  const [settings, sp, src, ex, nt, procs] = await Promise.all([
    getSettings(db),
    db.select().from(secretProviders).orderBy(secretProviders.name),
    db.select().from(sources).orderBy(sources.name),
    db.select().from(destinations).orderBy(destinations.name),
    db.select().from(notifiers).orderBy(notifiers.name),
    db.select().from(processes).orderBy(processes.name),
  ]);
  const nameOf = new Map<string, string>();
  for (const r of [...src, ...ex, ...nt]) nameOf.set(r.id, r.name);
  const name = (id: string): string => nameOf.get(id) ?? id;
  const { oidc: _oidc, ...portableSettings } = settings;
  const file: ConfigurationFile = {
    apiVersion: 'switchboard/v1',
    kind: 'Configuration',
    settings: {
      ...portableSettings,
      systemNotifierId: portableSettings.systemNotifierId
        ? name(portableSettings.systemNotifierId)
        : null,
      export: {
        ...portableSettings.export,
        sourceId: portableSettings.export.sourceId ? name(portableSettings.export.sourceId) : null,
      },
    },
    secretProviders: sp.map((r) => ({
      name: r.name,
      type: r.typeId,
      enabled: r.enabled,
      settings: r.settings,
    })),
    sources: src.map((r) => ({
      name: r.name,
      type: r.typeId,
      enabled: r.enabled,
      settings: r.settings,
      caps: r.caps as Record<string, unknown>,
    })),
    destinations: ex.map((r) => ({
      name: r.name,
      type: r.typeId,
      enabled: r.enabled,
      settings: r.settings,
      caps: r.caps as Record<string, unknown>,
      targetDefaults: r.targetDefaults,
    })),
    notifiers: nt.map((r) => ({
      name: r.name,
      type: r.typeId,
      enabled: r.enabled,
      settings: r.settings,
    })),
    processes: procs.map((p) => {
      const d = p.document;
      return {
        ...d,
        triggers: d.triggers.map(({ sourceId, ...t }) => ({ ...t, source: name(sourceId) })),
        destination: { instance: name(d.destination.instanceId), target: d.destination.target },
        before: d.before.map((s) => ({ ...s, provider: name(s.provider) })),
        after: d.after.map((s) => ({ ...s, provider: name(s.provider) })),
        notify: d.notify.map(({ notifierId, ...n }) => ({ ...n, notifier: name(notifierId) })),
      };
    }),
  };
  return stringify(file, { lineWidth: 120 });
}

export interface ApplyOptions {
  actor: string;
  reason: string;
  now: Date;
  dryRun: boolean;
}

export interface ApplyDeps {
  db: Db;
  runtime: PluginRuntime;
  clock: Clock;
  probe: SourceProbe;
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

/**
 * One transaction, matched by name. Additive: nothing missing from the file is deleted. A dry run
 * rolls back. Instances and processes go through the same checks and writes as the API.
 */
export async function applyConfiguration(
  deps: ApplyDeps,
  yamlText: string,
  opts: ApplyOptions,
): Promise<ApplyResponse> {
  let file: ConfigurationFile;
  try {
    file = parse(yamlText) as ConfigurationFile;
  } catch (err) {
    return { dryRun: opts.dryRun, changes: [], errors: [`YAML: ${errorText(err)}`] };
  }
  const upgraded = upgradeLegacyConfiguration(file);
  if (upgraded.errors.length > 0) {
    return { dryRun: opts.dryRun, changes: [], errors: upgraded.errors };
  }
  file = upgraded.file as ConfigurationFile;
  const check = validateAgainst(fileSchema, file);
  if (!check.valid) return { dryRun: opts.dryRun, changes: [], errors: check.errors };

  const changes: Change[] = [];
  const errors: string[] = [];
  const rollback = new Error('rollback');
  const meta: ChangeMeta = { actor: opts.actor, reason: `apply: ${opts.reason}`, now: opts.now };

  try {
    await deps.db.transaction(async (tx) => {
      const upsert = async <K extends InstanceKind>(
        kind: K,
        specs: SpecOf<K>[] | undefined,
      ): Promise<void> => {
        const table: InstanceTable = INSTANCE_TABLES[kind];
        const existing = await tx.select({ id: table.id, name: table.name }).from(table);
        for (const spec of specs ?? []) {
          const where = `${kind} "${spec.name}"`;
          if (!instanceType(deps.runtime, kind, spec.type)) {
            errors.push(`${where}: no installed plugin provides type ${spec.type}`);
            continue;
          }
          const draft = draftOf(spec);
          const row = existing.find((r) => r.name === spec.name);
          try {
            if (!row) {
              const record = await checkNewInstance(deps, kind, randomUUID(), draft);
              await insertInstance(tx, kind, record, meta);
              changes.push({ kind, name: spec.name, action: 'create' });
              continue;
            }
            const before = await loadInstance(tx, kind, row.id);
            if (before.typeId !== spec.type) {
              errors.push(`${where} exists with type ${before.typeId}; a type cannot change`);
              continue;
            }
            const checked = await checkInstanceChange(deps, kind, before, draft);
            const after = { ...checked, enabled: draft.enabled ?? true };
            if (canonical(comparable(before)) === canonical(comparable(after))) {
              changes.push({ kind, name: spec.name, action: 'unchanged' });
              continue;
            }
            await writeInstanceChange(tx, kind, before, after, meta);
            changes.push({ kind, name: spec.name, action: 'update' });
          } catch (err) {
            errors.push(...problemsOf(err).map((p) => `${where}: ${p}`));
          }
        }
      };

      await upsert('secret_provider', file.secretProviders);
      await upsert('source', file.sources);
      await upsert('destination', file.destinations);
      await upsert('notifier', file.notifiers);

      const ids = new Map<string, string>();
      for (const kind of ['source', 'destination', 'notifier'] as const) {
        const table = INSTANCE_TABLES[kind];
        for (const r of await tx.select({ id: table.id, name: table.name }).from(table))
          ids.set(`${kind}:${r.name}`, r.id);
      }
      const idOf = (kind: string, name: string, where: string): string => {
        const id = ids.get(`${kind}:${name}`);
        if (!id) {
          errors.push(`${where}: no ${kind} named "${name}"`);
          return '';
        }
        return id;
      };
      const providerId = (name: string, where: string): string =>
        ids.get(`source:${name}`) ??
        ids.get(`destination:${name}`) ??
        idOf('source or destination', name, where);

      if (file.settings) {
        const current = await getSettings(tx);
        const s = file.settings;
        const next: GlobalSettings = {
          ...mergeSettings(current, s),
          oidc: current.oidc,
          export: {
            ...current.export,
            ...s.export,
            sourceId: s.export?.sourceId
              ? idOf('source', s.export.sourceId, 'settings.export.sourceId')
              : current.export.sourceId,
          },
          systemNotifierId: s.systemNotifierId
            ? idOf('notifier', s.systemNotifierId, 'settings.systemNotifierId')
            : 'systemNotifierId' in s
              ? null
              : current.systemNotifierId,
        };
        if (canonical(next) !== canonical(current)) {
          await putSettings(tx, next, opts.now);
          changes.push({ kind: 'settings', name: 'global', action: 'update' });
          await auditChange(tx, meta, {
            scope: 'settings',
            targetId: 'global',
            field: 'applied',
            after: next,
          });
        } else {
          changes.push({ kind: 'settings', name: 'global', action: 'unchanged' });
        }
      }

      const existingProcs = await tx.select().from(processes);
      // YAML is untrusted input: every nested list may be missing.
      for (const p of (file.processes ?? []) as (Partial<PortableProcess> & { name: string })[]) {
        const where = `process "${p.name}"`;
        const draft = {
          ...p,
          triggers: (p.triggers ?? []).map(({ source, ...t }) => ({
            ...t,
            sourceId: idOf('source', source, where),
          })),
          destination: {
            instanceId: idOf('destination', p.destination?.instance ?? '', where),
            target: p.destination?.target ?? {},
          },
          before: (p.before ?? []).map((s) => ({ ...s, provider: providerId(s.provider, where) })),
          after: (p.after ?? []).map((s) => ({ ...s, provider: providerId(s.provider, where) })),
          notify: (p.notify ?? []).map(({ notifier, ...n }) => ({
            ...n,
            notifierId: idOf('notifier', notifier, where),
          })),
        };
        let doc: ProcessDocument;
        try {
          doc = await validateProcessDocument(deps, tx, draft);
        } catch (err) {
          errors.push(...problemsOf(err).map((m) => `${where}: ${m}`));
          continue;
        }
        const row = existingProcs.find((r) => r.name === p.name);
        if (!row) {
          await insertProcess(tx, doc, meta);
          changes.push({ kind: 'process', name: p.name, action: 'create' });
        } else if (canonical(row.document) === canonical(doc)) {
          changes.push({ kind: 'process', name: p.name, action: 'unchanged' });
        } else {
          await saveProcessVersionIn(tx, row.id, meta, () => ({
            document: doc,
            audit: { field: 'applied', after: doc },
          }));
          changes.push({ kind: 'process', name: p.name, action: 'update' });
        }
      }

      if (opts.dryRun || errors.length > 0) throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
  return { dryRun: opts.dryRun, changes, errors };
}
