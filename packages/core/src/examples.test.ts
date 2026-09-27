import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { validateAgainst, type PluginDefinition } from '@ai-switchboard/sdk';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { referenceTolerantSchema } from './api/routes/instances.js';
import { processDocumentSchema } from './domain/process.js';

const PLUGINS = [
  'source-webhook',
  'source-poll-http',
  'source-github',
  'source-linear',
  'source-datadog',
  'executor-http',
  'executor-claude-routines',
  'executor-github-actions',
  'executor-log',
  'notifier-slack',
  'notifier-webhook',
  'secrets-env',
  'secrets-file',
];

interface AnyType {
  id: string;
  settingsSchema: Record<string, unknown>;
  eventTypes?: { type: string }[];
  dynamicEventTypes?: boolean;
  targetSchema?: Record<string, unknown>;
}

interface ExampleInstance {
  name: string;
  type: string;
  settings?: Record<string, unknown>;
}

interface ExampleFile {
  sources?: ExampleInstance[];
  executors?: ExampleInstance[];
  notifiers?: ExampleInstance[];
  secretProviders?: ExampleInstance[];
  processes?: {
    name: string;
    triggers?: { source: string; eventTypes: string[] }[];
    executor?: { instance: string; target: unknown };
  }[];
}

const examplesDir = fileURLToPath(new URL('../../../examples', import.meta.url));

async function loadTypes(): Promise<Map<string, AnyType>> {
  const types = new Map<string, AnyType>();
  for (const name of PLUGINS) {
    const mod = (await import(`@ai-switchboard/${name}`)) as { default: PluginDefinition };
    const def = mod.default;
    const lists = {
      sources: def.sources,
      executors: def.executors,
      notifiers: def.notifiers,
      secretProviders: def.secretProviders,
    };
    for (const [kind, list] of Object.entries(lists)) {
      for (const t of list as AnyType[]) types.set(`${kind}:${t.id}`, t);
    }
  }
  return types;
}

describe('examples/*.yaml', async () => {
  const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.yaml'));
  const types = await loadTypes();

  it.each(files)('%s matches the reference plugins and the process schema', async (file) => {
    const doc = parse(await readFile(`${examplesDir}/${file}`, 'utf8')) as ExampleFile;
    const problems: string[] = [];
    for (const kind of ['sources', 'executors', 'notifiers', 'secretProviders'] as const) {
      for (const inst of doc[kind] ?? []) {
        const t = types.get(`${kind}:${inst.type}`);
        if (!t) {
          problems.push(`${kind} ${inst.name}: unknown type ${inst.type}`);
          continue;
        }
        const check = validateAgainst(
          referenceTolerantSchema(t.settingsSchema),
          structuredClone(inst.settings ?? {}),
        );
        if (!check.valid) problems.push(`${kind} ${inst.name}: ${check.errors.join('; ')}`);
      }
    }
    for (const p of doc.processes ?? []) {
      for (const tr of p.triggers ?? []) {
        const src = doc.sources?.find((s) => s.name === tr.source);
        const t = src ? types.get(`sources:${src.type}`) : undefined;
        if (!t) problems.push(`process ${p.name}: trigger source ${tr.source} not in the file`);
        else if (!t.dynamicEventTypes) {
          for (const et of tr.eventTypes) {
            if (!t.eventTypes?.some((e) => e.type === et))
              problems.push(`process ${p.name}: ${tr.source} has no event type ${et}`);
          }
        }
      }
      const ex = doc.executors?.find((e) => e.name === p.executor?.instance);
      const t = ex ? types.get(`executors:${ex.type}`) : undefined;
      if (!t?.targetSchema)
        problems.push(`process ${p.name}: executor ${p.executor?.instance ?? '?'} not in the file`);
      else {
        const c = validateAgainst(t.targetSchema, structuredClone(p.executor?.target));
        if (!c.valid) problems.push(`process ${p.name} target: ${c.errors.join('; ')}`);
      }
      // Structural check with ids standing in for names.
      const structural = validateAgainst(processDocumentSchema, {
        ...p,
        triggers: (p.triggers ?? []).map(({ source, ...rest }) => ({ ...rest, sourceId: source })),
        executor: { instanceId: p.executor?.instance ?? '', target: p.executor?.target ?? {} },
        notify: ((p as { notify?: { notifier: string }[] }).notify ?? []).map(
          ({ notifier, ...n }) => ({ ...n, notifierId: notifier }),
        ),
      });
      if (!structural.valid) problems.push(`process ${p.name}: ${structural.errors.join('; ')}`);
    }
    expect(problems).toEqual([]);
  });
});
