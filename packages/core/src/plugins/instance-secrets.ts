import {
  isSecretNotFoundError,
  isWritableSecretProvider,
  SECRET_KEY_PATTERN,
  SecretStoreError,
  type InstanceSecrets,
  type SecretProvider,
  type SecretStoreStatus,
} from '@ai-switchboard/sdk';

import type { CoreLogger } from '../logger.js';
import { collectSecretRefs, parseSecretRef, redactSecretValues } from '../secrets/refs.js';
import { errorText } from '../util/errors.js';

/** Where `ctx.secrets.set(key)` lands in the provider: one name per instance and key. */
export function instanceSecretName(instanceId: string, key: string): string {
  return `${instanceSecretPrefix(instanceId)}${key}`;
}

export function instanceSecretPrefix(instanceId: string): string {
  return `switchboard-${instanceId}-`;
}

/** The providers an instance's settings reference, in the order the references appear. */
export function referencedProviders(settings: unknown): string[] {
  const names: string[] = [];
  for (const { ref } of collectSecretRefs(settings)) {
    const parsed = parseSecretRef(ref);
    if (parsed && !names.includes(parsed.provider)) names.push(parsed.provider);
  }
  return names;
}

export interface NamedProvider {
  name: string;
  provider: SecretProvider;
}

type WritableProvider = SecretProvider & Required<Pick<SecretProvider, 'set' | 'delete'>>;

export type StoreChoice =
  | { writable: true; target: { name: string; provider: WritableProvider } }
  | { writable: false; reason: string };

/**
 * The first writable provider among the ones the settings reference, so a rotated credential
 * lives next to the seed it came from. Never anything else: no reference, no store.
 */
export function chooseStore(
  referenced: readonly string[],
  lookup: (name: string) => SecretProvider | undefined,
): StoreChoice {
  if (referenced.length === 0)
    return {
      writable: false,
      reason: "the instance's settings reference no secret provider",
    };
  const notRunning: string[] = [];
  for (const name of referenced) {
    const provider = lookup(name);
    if (!provider) {
      notRunning.push(name);
      continue;
    }
    if (isWritableSecretProvider(provider)) return { writable: true, target: { name, provider } };
  }
  const readOnly = referenced.filter((n) => !notRunning.includes(n));
  const parts = [
    ...(readOnly.length > 0
      ? [`${readOnly.map((n) => `"${n}"`).join(', ')} cannot store values`]
      : []),
    ...(notRunning.length > 0
      ? [`${notRunning.map((n) => `"${n}"`).join(', ')} is not running`]
      : []),
  ];
  return {
    writable: false,
    reason: `secret provider ${parts.join('; ')}; reference a writable one (for example the file provider with writes on)`,
  };
}

export interface InstanceSecretsDeps {
  instanceId: string;
  /** The instance's settings as stored, with `secret://` references. */
  settings: unknown;
  provider(name: string): SecretProvider | undefined;
  logger: CoreLogger;
  /** Every value read or written here is added, so the state store can refuse it. */
  known: Set<string>;
}

function checkKey(key: string): void {
  if (!SECRET_KEY_PATTERN.test(key))
    throw new SecretStoreError(
      `"${key}" is not a valid secret key (lower-case letters, digits, - and _)`,
    );
}

export function createInstanceSecrets(deps: InstanceSecretsDeps): InstanceSecrets {
  const referenced = referencedProviders(deps.settings);
  const choose = () => chooseStore(referenced, (name) => deps.provider(name));
  const writableTarget = () => {
    const choice = choose();
    if (!choice.writable) throw new SecretStoreError(choice.reason);
    return choice.target;
  };
  const fail = (action: string, key: string, target: NamedProvider, err: unknown, value?: string) =>
    new SecretStoreError(
      redactSecretValues(
        `could not ${action} "${key}" in secret provider "${target.name}": ${errorText(err)}`,
        value !== undefined ? [value] : [],
      ) as string,
    );

  return {
    async get(key) {
      checkKey(key);
      const choice = choose();
      if (!choice.writable) return undefined;
      try {
        const value = await choice.target.provider.resolve(
          instanceSecretName(deps.instanceId, key),
        );
        deps.known.add(value);
        return value;
      } catch (err) {
        if (isSecretNotFoundError(err)) return undefined;
        throw fail('read', key, choice.target, err);
      }
    },
    async set(key, value) {
      checkKey(key);
      const target = writableTarget();
      deps.known.add(value);
      try {
        await target.provider.set(instanceSecretName(deps.instanceId, key), value);
      } catch (err) {
        throw fail('store', key, target, err, value);
      }
      deps.logger.debug({ key, provider: target.name }, 'stored a rotated instance credential');
    },
    async delete(key) {
      checkKey(key);
      const target = writableTarget();
      try {
        await target.provider.delete(instanceSecretName(deps.instanceId, key));
      } catch (err) {
        throw fail('delete', key, target, err);
      }
    },
    check(): Promise<SecretStoreStatus> {
      const choice = choose();
      return Promise.resolve(
        choice.writable
          ? { writable: true, provider: choice.target.name }
          : { writable: false, reason: choice.reason },
      );
    },
  };
}
