import type { DbOrTx } from '../db/client.js';
import { processes } from '../db/schema.js';
import { referencesInstance, type ProcessDocument } from '../domain/process.js';

export interface ProcessRef {
  id: string;
  name: string;
  document: ProcessDocument;
}

/** Every process's id, name and document: loaded once per request and passed to the read models. */
export async function loadProcessRefs(db: DbOrTx): Promise<ProcessRef[]> {
  return db
    .select({ id: processes.id, name: processes.name, document: processes.document })
    .from(processes);
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
