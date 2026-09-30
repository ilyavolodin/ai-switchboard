import { schemaFields, xSecret } from '../../schema/index.js';
import type { JSONSchema } from '../../types/common.js';
import { assert, type ConformanceCheck } from './shared.js';

export interface SettingsSchemaOptions {
  /** Field names that look like credentials but are not (e.g. a header *name*). */
  notSecret?: string[];
}

const CREDENTIAL_NAME =
  /(token|secret|password|passphrase|apikey|appkey|privatekey|accesskey|signingkey)$/i;

/**
 * The settings-form rules: every field has a `title` and a `description` (the UI renders the
 * form from them), and every credential-looking field is marked `x-secret: true`.
 */
export function settingsSchemaChecks(
  schema: JSONSchema,
  options: SettingsSchemaOptions = {},
): ConformanceCheck[] {
  const notSecret = new Set(options.notSecret ?? []);
  return [
    {
      name: 'every settings field has a title and a description',
      run: () => {
        const missing = schemaFields(schema).flatMap(({ path, schema: sub }) => {
          const gaps = [
            typeof sub.title === 'string' && sub.title !== '' ? [] : ['title'],
            typeof sub.description === 'string' && sub.description !== '' ? [] : ['description'],
          ].flat();
          return gaps.length > 0 ? [`${path} (${gaps.join(', ')})`] : [];
        });
        assert(missing.length === 0, `settings fields missing: ${missing.join('; ')}`);
        return Promise.resolve();
      },
    },
    {
      name: 'credential settings fields are marked x-secret',
      run: () => {
        const unmarked = schemaFields(schema)
          .filter(({ path, schema: sub }) => {
            const name = path.split('.').at(-1) ?? path;
            return CREDENTIAL_NAME.test(name) && !notSecret.has(path) && !xSecret(sub);
          })
          .map(({ path }) => path);
        assert(unmarked.length === 0, `credential fields without x-secret: ${unmarked.join(', ')}`);
        return Promise.resolve();
      },
    },
  ];
}
