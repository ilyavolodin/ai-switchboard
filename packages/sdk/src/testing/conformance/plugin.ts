import type { PluginDefinition } from '../../plugin.js';
import type { JSONSchema } from '../../types/common.js';
import { destinationChecks, type DestinationFixtures } from './destination.js';
import { notifierChecks, type NotifierFixtures } from './notifier.js';
import { secretProviderChecks, type SecretProviderFixtures } from './secret-provider.js';
import { settingsSchemaChecks, type SettingsSchemaOptions } from './settings.js';
import { assert, manifestCheck, type ConformanceCheck, type Violations } from './shared.js';
import { sourceChecks, type SourceFixtures } from './source.js';

/** Fixtures per type id; a type without fixtures gets only its manifest and settings checks. */
export interface PluginFixtures {
  sources?: Record<string, SourceFixtures>;
  destinations?: Record<string, DestinationFixtures>;
  notifiers?: Record<string, NotifierFixtures>;
  secretProviders?: Record<string, SecretProviderFixtures>;
  settings?: SettingsSchemaOptions;
}

function prefixed(prefix: string, checks: ConformanceCheck[]): ConformanceCheck[] {
  return checks.map((c) => ({ name: `${prefix}: ${c.name}`, run: () => c.run() }));
}

interface TypeGroup<T extends { id: string; settingsSchema: JSONSchema }, F> {
  label: string;
  types: T[];
  fixtures: Record<string, F> | undefined;
  checks: (type: T, fixtures: F, violations: Violations) => ConformanceCheck[];
}

/**
 * The manifest check; with `fixtures`, also every type's settings-form checks and type checks,
 * run with the plugin's `capabilities.network` enforced, and a final check that no call left it.
 */
export function pluginConformanceChecks(
  plugin: PluginDefinition,
  fixtures?: PluginFixtures,
): ConformanceCheck[] {
  const manifest = manifestCheck(() => plugin, `plugin ${plugin.id} manifest validates`);
  if (!fixtures) return [manifest];

  const allowedHosts = plugin.capabilities.network ?? [];
  const violations: Violations = [];
  const checks: ConformanceCheck[] = [manifest];
  const add = <T extends { id: string; settingsSchema: JSONSchema }, F>(
    group: TypeGroup<T, F>,
  ): void => {
    for (const t of group.types) {
      const f = group.fixtures?.[t.id];
      checks.push(
        ...prefixed(`${group.label} ${t.id}`, [
          ...settingsSchemaChecks(t.settingsSchema, fixtures.settings),
          ...(f ? group.checks(t, { allowedHosts, ...f }, violations) : []),
        ]),
      );
    }
  };
  add({ label: 'source', types: plugin.sources, fixtures: fixtures.sources, checks: sourceChecks });
  add({
    label: 'destination',
    types: plugin.destinations,
    fixtures: fixtures.destinations,
    checks: destinationChecks,
  });
  add({
    label: 'notifier',
    types: plugin.notifiers,
    fixtures: fixtures.notifiers,
    checks: notifierChecks,
  });
  add({
    label: 'secret provider',
    types: plugin.secretProviders,
    fixtures: fixtures.secretProviders,
    checks: secretProviderChecks,
  });
  checks.push({
    name: `plugin ${plugin.id} calls only the hosts in capabilities.network`,
    run: () => {
      assert(
        violations.length === 0,
        `calls outside capabilities.network: ${[...new Set(violations)].join('; ')}`,
      );
      return Promise.resolve();
    },
  });
  return checks;
}

interface TestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
}

/** Registers checks with any describe/it test runner, e.g. vitest's `{ describe, it }`. */
export function runConformance(title: string, checks: ConformanceCheck[], api: TestApi): void {
  api.describe(`conformance: ${title}`, () => {
    for (const check of checks) api.it(check.name, () => check.run());
  });
}
