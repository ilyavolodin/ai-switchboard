export interface InstanceVersion {
  id: string;
  version: number;
}

export interface InstanceDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/** Ids for which `skip` returns true (a build is in flight) are left for the next pass. */
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
