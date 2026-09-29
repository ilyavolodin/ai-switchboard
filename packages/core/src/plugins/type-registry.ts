import type {
  DestinationType,
  NotifierType,
  PluginDefinition,
  SecretProviderType,
  SourceType,
} from '@ai-switchboard/sdk';

import { INSTANCE_KINDS, type InstanceKind } from '../domain/status.js';

export interface TypeByKind {
  source: SourceType;
  destination: DestinationType;
  notifier: NotifierType;
  secret_provider: SecretProviderType;
}

export type AnyType = TypeByKind[InstanceKind];

export interface TypeEntry<T> {
  type: T;
  pluginName: string;
}

export interface RegisteredType<K extends InstanceKind = InstanceKind> {
  kind: K;
  typeId: string;
  pluginName: string;
  type: TypeByKind[K];
}

type Maps = { [K in InstanceKind]: Map<string, TypeEntry<TypeByKind[K]>> };

function typesOf<K extends InstanceKind>(def: PluginDefinition, kind: K): TypeByKind[K][] {
  const lists: { [P in InstanceKind]: TypeByKind[P][] } = {
    source: def.sources,
    destination: def.destinations,
    notifier: def.notifiers,
    secret_provider: def.secretProviders,
  };
  return lists[kind];
}

/** Every type id a loaded plugin provides, by kind; one plugin per type id. */
export class TypeRegistry {
  private readonly maps: Maps = {
    source: new Map(),
    destination: new Map(),
    notifier: new Map(),
    secret_provider: new Map(),
  };

  get<K extends InstanceKind>(kind: K, typeId: string): TypeEntry<TypeByKind[K]> | undefined {
    return this.maps[kind].get(typeId);
  }

  has(kind: InstanceKind, typeId: string): boolean {
    return this.maps[kind].has(typeId);
  }

  /** Why `def` cannot be registered next to what is already there, or undefined. */
  findClash(def: PluginDefinition): string | undefined {
    for (const kind of INSTANCE_KINDS) {
      for (const t of typesOf(def, kind)) {
        const existing = this.maps[kind].get(t.id);
        if (existing) return `${kind} type "${t.id}" is already provided by ${existing.pluginName}`;
      }
    }
    return undefined;
  }

  register(pluginName: string, def: PluginDefinition): void {
    for (const kind of INSTANCE_KINDS) this.registerKind(kind, pluginName, def);
  }

  private registerKind<K extends InstanceKind>(
    kind: K,
    pluginName: string,
    def: PluginDefinition,
  ): void {
    const map = this.maps[kind] as Map<string, TypeEntry<TypeByKind[K]>>;
    for (const type of typesOf(def, kind)) map.set(type.id, { type, pluginName });
  }

  /** Removes the plugin's types and returns them. */
  unregister(pluginName: string): { kind: InstanceKind; typeId: string }[] {
    const dropped: { kind: InstanceKind; typeId: string }[] = [];
    for (const kind of INSTANCE_KINDS) {
      for (const [typeId, entry] of this.maps[kind]) {
        if (entry.pluginName !== pluginName) continue;
        this.maps[kind].delete(typeId);
        dropped.push({ kind, typeId });
      }
    }
    return dropped;
  }

  /** Every registered type, or one plugin's. */
  list(pluginName?: string): RegisteredType[] {
    const out: RegisteredType[] = [];
    for (const kind of INSTANCE_KINDS) {
      for (const [typeId, entry] of this.maps[kind]) {
        if (pluginName !== undefined && entry.pluginName !== pluginName) continue;
        out.push({ kind, typeId, pluginName: entry.pluginName, type: entry.type });
      }
    }
    return out;
  }
}
