/** One instance row as the reconcile pass reads it: its id and build version. */
export interface InstanceVersion {
  id: string;
  version: number;
}

/** What a replica must do to match one instance table. */
export interface InstanceDiff {
  /** Rows this replica has never built. */
  added: string[];
  /** Rows whose version differs from the one this replica built. */
  changed: string[];
  /** Instances this replica built whose row is gone. */
  removed: string[];
}

/**
 * Compare an instance table's rows with the versions this replica last built. Ids for which
 * `skip` returns true (a build of them is in flight) are left for the next pass.
 */
export function diffInstances(
  rows: readonly InstanceVersion[],
  built: ReadonlyMap<string, number>,
  skip: (id: string) => boolean = () => false,
): InstanceDiff {
  const diff: InstanceDiff = { added: [], changed: [], removed: [] };
  const present = new Set<string>();
  for (const row of rows) {
    present.add(row.id);
    if (skip(row.id)) continue;
    const version = built.get(row.id);
    if (version === undefined) diff.added.push(row.id);
    else if (version !== row.version) diff.changed.push(row.id);
  }
  for (const id of built.keys()) if (!present.has(id) && !skip(id)) diff.removed.push(id);
  return diff;
}
