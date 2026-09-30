import type { InstanceError } from '../../domain/instance-error.js';
import { INSTANCE_KINDS, type InstanceKind } from '../../domain/status.js';
import type { LiveDestination, LiveNotifier, LiveSecretProvider, LiveSource } from '../runtime.js';

export interface LiveByKind {
  source: LiveSource;
  destination: LiveDestination;
  notifier: LiveNotifier;
  secret_provider: LiveSecretProvider;
}

/** The row a build read: its kind, `config_version` and name. */
export interface BuiltInstance {
  kind: InstanceKind;
  version: number;
  name: string;
}

export type BuildOutcome<K extends InstanceKind = InstanceKind> =
  { kind: K; live: LiveByKind[K]; error?: InstanceError } | { error: InstanceError } | undefined;

type Maps = { [K in InstanceKind]: Map<string, LiveByKind[K]> };

/**
 * The live objects of one replica, and the bookkeeping that keeps concurrent builds of one
 * instance in order. Take a ticket before reading the rows a build uses; `commit` swaps in the
 * result unless a build holding a later ticket (so one that read a newer row) has claimed the
 * instance. Until the swap the previous object keeps serving, so a reload never leaves a gap
 * while secrets resolve.
 */
export class LiveSet {
  private readonly maps: Maps = {
    source: new Map(),
    destination: new Map(),
    notifier: new Map(),
    secret_provider: new Map(),
  };
  private readonly providersByName = new Map<string, LiveSecretProvider>();
  private readonly errors = new Map<string, InstanceError>();
  private readonly claims = new Map<string, number>();
  private readonly built = new Map<string, BuiltInstance>();
  /** Reloads in flight on this replica; a reconcile pass leaves them alone. */
  private readonly pending = new Map<string, number>();
  private epoch = 0;

  get<K extends InstanceKind>(kind: K, id: string): LiveByKind[K] | undefined {
    return this.maps[kind].get(id);
  }

  values<K extends InstanceKind>(kind: K): LiveByKind[K][] {
    return [...this.maps[kind].values()];
  }

  provider(name: string): LiveSecretProvider | undefined {
    return this.providersByName.get(name);
  }

  error(id: string): InstanceError | undefined {
    return this.errors.get(id);
  }

  builtOf(id: string): BuiltInstance | undefined {
    return this.built.get(id);
  }

  /** `config_version` of every instance of `kind` built here. */
  builtVersions(kind: InstanceKind): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, b] of this.built) if (b.kind === kind) out.set(id, b.version);
    return out;
  }

  ticket(): number {
    return ++this.epoch;
  }

  /** Claim before reading the row: an older build finishing later cannot win. */
  claim(id: string, ticket: number): void {
    this.claims.set(id, ticket);
  }

  /** A reload is in flight, or a build newer than `ticket` claimed the instance. */
  busy(id: string, ticket: number): boolean {
    return this.pending.has(id) || (this.claims.get(id) ?? 0) > ticket;
  }

  /** `from` undefined: the row is gone, and so is the instance. */
  commit(
    id: string,
    ticket: number,
    outcome: BuildOutcome,
    from: BuiltInstance | undefined,
  ): boolean {
    if ((this.claims.get(id) ?? 0) > ticket) return false;
    this.claims.set(id, ticket);
    this.clear(id);
    if (outcome && 'kind' in outcome) this.set(outcome.kind, id, outcome.live);
    if (outcome?.error !== undefined) this.errors.set(id, outcome.error);
    if (from) this.built.set(id, from);
    else this.built.delete(id);
    return true;
  }

  async withPending<T>(ids: readonly string[], fn: () => Promise<T>): Promise<T> {
    for (const id of ids) this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      for (const id of ids) {
        const n = (this.pending.get(id) ?? 1) - 1;
        if (n > 0) this.pending.set(id, n);
        else this.pending.delete(id);
      }
    }
  }

  private set<K extends InstanceKind>(kind: K, id: string, live: LiveByKind[K]): void {
    (this.maps[kind] as Map<string, LiveByKind[K]>).set(id, live);
    if (kind === 'secret_provider') {
      const provider = live as LiveSecretProvider;
      this.providersByName.set(provider.name, provider);
    }
  }

  private clear(id: string): void {
    const provider = this.maps.secret_provider.get(id);
    if (provider) this.providersByName.delete(provider.name);
    for (const kind of INSTANCE_KINDS) this.maps[kind].delete(id);
    this.errors.delete(id);
  }
}
