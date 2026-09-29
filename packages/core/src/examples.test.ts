import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { validateAgainst, type PluginDefinition } from '@ai-switchboard/sdk';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { referenceTolerantSchema } from './services/instance-validation.js';
import { processDocumentSchema } from './domain/process.js';

const PLUGINS = [
  'source-webhook',
  'source-poll-http',
  'source-github',
  'source-linear',
  'source-datadog',
  'destination-http',
  'destination-claude-routines',
  'destination-github-actions',
  'destination-log',
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
  destinations?: ExampleInstance[];
  notifiers?: ExampleInstance[];
  secretProviders?: ExampleInstance[];
  processes?: {
    name: string;
    triggers?: { source: string; eventTypes: string[] }[];
    destination?: { instance: string; target: unknown };
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
      destinations: def.destinations,
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
    for (const kind of ['sources', 'destinations', 'notifiers', 'secretProviders'] as const) {
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
      const ex = doc.destinations?.find((e) => e.name === p.destination?.instance);
      const t = ex ? types.get(`destinations:${ex.type}`) : undefined;
      if (!t?.targetSchema)
        problems.push(
          `process ${p.name}: destination ${p.destination?.instance ?? '?'} not in the file`,
        );
      else {
        const c = validateAgainst(t.targetSchema, structuredClone(p.destination?.target));
        if (!c.valid) problems.push(`process ${p.name} target: ${c.errors.join('; ')}`);
      }
      // Ids stand in for names.
      const structural = validateAgainst(processDocumentSchema, {
        ...p,
        triggers: (p.triggers ?? []).map(({ source, ...rest }) => ({ ...rest, sourceId: source })),
        destination: {
          instanceId: p.destination?.instance ?? '',
          target: p.destination?.target ?? {},
        },
        notify: ((p as { notify?: { notifier: string }[] }).notify ?? []).map(
          ({ notifier, ...n }) => ({ ...n, notifierId: notifier }),
        ),
      });
      if (!structural.valid) problems.push(`process ${p.name}: ${structural.errors.join('; ')}`);
    }
    expect(problems).toEqual([]);
  });
});
