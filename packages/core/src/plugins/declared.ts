import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Capabilities, PluginKind } from '@ai-switchboard/sdk';
import { isPluginDefinition } from '@ai-switchboard/sdk/host';

import { errorText } from '../util/errors.js';
import { isRecord, str } from '../util/guards.js';

import { pluginEntry, type SwitchboardField } from './package-manifest.js';

export type ImportModule = (url: string) => Promise<unknown>;

export const defaultImport: ImportModule = (url) => import(url);

export interface PluginManifestSummary {
  pluginId: string;
  displayName: string;
  types: { kind: PluginKind; typeId: string; displayName: string }[];
}

/** What a package declares, read by importing its entry; undefined when it could not be read. */
export interface DeclaredPlugin {
  capabilities: Capabilities | undefined;
  plugin: PluginManifestSummary | undefined;
}

const UNKNOWN: DeclaredPlugin = { capabilities: undefined, plugin: undefined };

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

function typesOf(kind: PluginKind, list: unknown): PluginManifestSummary['types'] {
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).flatMap((t) =>
    isRecord(t) && typeof t.id === 'string'
      ? [{ kind, typeId: t.id, displayName: str(t.displayName) ?? t.id }]
      : [],
  );
}

export function summarise(plugin: unknown): DeclaredPlugin {
  if (!isRecord(plugin)) return UNKNOWN;
  const caps = isRecord(plugin.capabilities) ? plugin.capabilities : {};
  const capabilities: Capabilities = {};
  const network = strings(caps.network);
  const secrets = strings(caps.secrets);
  if (network) capabilities.network = network;
  if (secrets) capabilities.secrets = secrets;
  if (!isPluginDefinition(plugin)) return { capabilities, plugin: undefined };
  const types = [
    ...typesOf('source', plugin.sources),
    ...typesOf('destination', plugin.destinations),
    ...typesOf('notifier', plugin.notifiers),
    ...typesOf('secret_provider', plugin.secretProviders),
  ];
  return {
    capabilities,
    plugin: { pluginId: plugin.id, displayName: plugin.displayName, types },
  };
}

/** Never throws: what could not be read is a warning. */
export async function readDeclared(
  packageDir: string,
  field: SwitchboardField,
  allowSource: boolean,
  importModule: ImportModule,
  warnings: string[],
): Promise<DeclaredPlugin> {
  const rel = await pluginEntry(packageDir, field, allowSource);
  try {
    const mod = await importModule(pathToFileURL(join(packageDir, rel)).href);
    const declared = isRecord(mod) ? mod.default : undefined;
    if (!isRecord(declared)) {
      warnings.push(`${rel} has no default export; capabilities could not be read`);
      return UNKNOWN;
    }
    return summarise(declared);
  } catch (err) {
    const message = errorText(err).split('\n')[0] ?? '';
    warnings.push(`could not import ${rel} to read capabilities: ${message}`);
    return UNKNOWN;
  }
}
