import type { DbOrTx } from '../db/client.js';
import { processes } from '../db/schema.js';
import { referencesInstance, type ProcessDocument } from '../domain/process.js';

export interface ProcessRef {
  id: string;
  name: string;
  enabled: boolean;
  document: ProcessDocument;
}

/** Every process's id, name and document: loaded once per request and passed to the read models. */
export async function loadProcessRefs(db: DbOrTx): Promise<ProcessRef[]> {
  return db
    .select({
      id: processes.id,
      name: processes.name,
      enabled: processes.enabled,
      document: processes.document,
    })
    .from(processes);
}

export function isBoundTo(destinationId: string): (p: Pick<ProcessRef, 'document'>) => boolean {
  return (p) => p.document.destination.instanceId === destinationId;
}

/** The processes that invoke this destination. */
export async function processesBoundTo(
  db: DbOrTx,
  destinationId: string,
  options: { enabledOnly?: boolean } = {},
): Promise<ProcessRef[]> {
  return (await loadProcessRefs(db)).filter(
    (p) => isBoundTo(destinationId)(p) && (options.enabledOnly !== true || p.enabled),
  );
}

/** Processes referencing an instance, so a delete can refuse while processes still use it. */
export async function processesUsing(
  db: DbOrTx,
  instanceId: string,
): Promise<{ id: string; name: string }[]> {
  return (await loadProcessRefs(db))
    .filter((p) => referencesInstance(p.document, instanceId))
    .map((p) => ({ id: p.id, name: p.name }));
}
