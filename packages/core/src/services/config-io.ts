import { validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';
import { parse, stringify } from 'yaml';

import type { ApplyResponse, GlobalSettings } from '../api/contract.js';
import type { Db, DbOrTx } from '../db/client.js';
import {
  destinations,
  notifiers,
  processes,
  processVersions,
  secretProviders,
  sources,
} from '../db/schema.js';
import type { ProcessDocument } from '../domain/process.js';
import { recordAudit } from './audit.js';
import { nextConfigVersion } from './instances.js';
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
  /** Undefined when the type is not installed. */
  validateSettings: (
    kind: 'source' | 'destination' | 'notifier' | 'secret_provider',
    typeId: string,
    settings: Record<string, unknown>,
  ) => string[] | undefined;
  validateProcess: (doc: ProcessDocument, tx: DbOrTx) => Promise<string[]>;
}

type Change = ApplyResponse['changes'][number];

/**
 * One transaction, matched by name. Additive: nothing missing from the file is deleted. A dry run
 * rolls back.
 */
export async function applyConfiguration(
  db: Db,
  yamlText: string,
  opts: ApplyOptions,
): Promise<ApplyResponse> {
  let file: ConfigurationFile;
  try {
    file = parse(yamlText) as ConfigurationFile;
  } catch (err) {
    return {
      dryRun: opts.dryRun,
      changes: [],
      errors: [`YAML: ${err instanceof Error ? err.message : String(err)}`],
    };
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

  try {
    await db.transaction(async (tx) => {
      const audit = (scope: string, targetId: string, field: string, after: unknown) =>
        recordAudit(tx, {
          actor: opts.actor,
          scope,
          targetId,
          field,
          after,
          reason: `apply: ${opts.reason}`,
          at: opts.now,
        });

      const upsert = async (
        kind: 'secret_provider' | 'source' | 'destination' | 'notifier',
        specs:
          | (InstanceSpec & {
              caps?: Record<string, unknown>;
              targetDefaults?: Record<string, unknown>;
            })[]
          | undefined,
      ): Promise<void> => {
        const table = {
          secret_provider: secretProviders,
          source: sources,
          destination: destinations,
          notifier: notifiers,
        }[kind];
        const existing = await tx.select().from(table);
        for (const spec of specs ?? []) {
          const problems = opts.validateSettings(kind, spec.type, spec.settings ?? {});
          if (problems === undefined) {
            errors.push(`${kind} "${spec.name}": no installed plugin provides type ${spec.type}`);
            continue;
          }
          if (problems.length > 0) {
            errors.push(...problems.map((p) => `${kind} "${spec.name}": ${p}`));
            continue;
          }
          const row = existing.find((r) => r.name === spec.name);
          const values: Record<string, unknown> = {
            typeId: spec.type,
            name: spec.name,
            settings: spec.settings ?? {},
            enabled: spec.enabled ?? true,
            updatedAt: opts.now,
          };
          if (kind === 'source' || kind === 'destination') values.caps = spec.caps ?? {};
          if (kind === 'destination') values.targetDefaults = spec.targetDefaults ?? {};
          if (!row) {
            await tx.insert(table).values({ ...values, createdAt: opts.now } as never);
            changes.push({ kind, name: spec.name, action: 'create' });
            await audit(kind, spec.name, 'created', values);
          } else {
            const before = {
              typeId: row.typeId,
              settings: row.settings,
              enabled: row.enabled,
              caps: 'caps' in row ? row.caps : undefined,
              targetDefaults: 'targetDefaults' in row ? row.targetDefaults : undefined,
            };
            const after = {
              typeId: values.typeId,
              settings: values.settings,
              enabled: values.enabled,
              caps: values.caps,
              targetDefaults: values.targetDefaults,
            };
            if (canonical(before) === canonical(after)) {
              changes.push({ kind, name: spec.name, action: 'unchanged' });
              continue;
            }
            if (row.typeId !== spec.type) {
              errors.push(
                `${kind} "${spec.name}" exists with type ${row.typeId}; a type cannot change`,
              );
              continue;
            }
            await tx
              .update(table)
              .set({ ...values, configVersion: nextConfigVersion(table) })
              .where(eq(table.id, row.id));
            changes.push({ kind, name: spec.name, action: 'update' });
            await audit(kind, row.id, 'applied', after);
          }
        }
      };

      await upsert('secret_provider', file.secretProviders);
      await upsert('source', file.sources);
      await upsert('destination', file.destinations);
      await upsert('notifier', file.notifiers);

      const ids = new Map<string, string>();
      for (const r of await tx.select({ id: sources.id, name: sources.name }).from(sources))
        ids.set(`source:${r.name}`, r.id);
      for (const r of await tx
        .select({ id: destinations.id, name: destinations.name })
        .from(destinations))
        ids.set(`destination:${r.name}`, r.id);
      for (const r of await tx.select({ id: notifiers.id, name: notifiers.name }).from(notifiers))
        ids.set(`notifier:${r.name}`, r.id);
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
          ...current,
          ...s,
          oidc: current.oidc,
          retention: { ...current.retention, ...s.retention },
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
          await audit('settings', 'global', 'applied', next);
        } else {
          changes.push({ kind: 'settings', name: 'global', action: 'unchanged' });
        }
      }

      const existingProcs = await tx.select().from(processes);
      // YAML is untrusted input: every nested list may be missing.
      for (const p of (file.processes ?? []) as (Partial<PortableProcess> & { name: string })[]) {
        const where = `process "${p.name}"`;
        const doc = {
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
        } as ProcessDocument;
        const problems = await opts.validateProcess(doc, tx);
        if (problems.length > 0) {
          errors.push(...problems.map((m) => `${where}: ${m}`));
          continue;
        }
        const row = existingProcs.find((r) => r.name === p.name);
        if (!row) {
          const [created] = await tx
            .insert(processes)
            .values({
              name: doc.name,
              document: doc,
              enabled: doc.enabled,
              version: 1,
              createdAt: opts.now,
              updatedAt: opts.now,
            })
            .returning({ id: processes.id });
          if (created) {
            await tx.insert(processVersions).values({
              processId: created.id,
              version: 1,
              document: doc,
              savedBy: opts.actor,
              savedAt: opts.now,
              reason: `apply: ${opts.reason}`,
            });
            await audit('process', created.id, 'created', doc);
          }
          changes.push({ kind: 'process', name: p.name, action: 'create' });
        } else if (canonical(row.document) === canonical(doc)) {
          changes.push({ kind: 'process', name: p.name, action: 'unchanged' });
        } else {
          const version = row.version + 1;
          await tx
            .update(processes)
            .set({ document: doc, enabled: doc.enabled, version, updatedAt: opts.now })
            .where(eq(processes.id, row.id));
          await tx.insert(processVersions).values({
            processId: row.id,
            version,
            document: doc,
            savedBy: opts.actor,
            savedAt: opts.now,
            reason: `apply: ${opts.reason}`,
          });
          await audit('process', row.id, 'applied', doc);
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
