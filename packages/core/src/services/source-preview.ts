import { and, desc, eq } from 'drizzle-orm';

import type { RawRequest } from '@ai-switchboard/sdk';

import type {
  LastDeliveryResponse,
  SampleDeliveryDTO,
  SourcePreviewEvent,
  SourcePreviewResponse,
} from '../api/contract.js';
import { eventRaw, sources } from '../db/schema.js';
import type { Deps } from '../deps.js';
import type { LiveSource } from '../plugins/runtime.js';
import { REDACTED, redactSecretValues } from '../secrets/refs.js';

import { errorText } from '../util/errors.js';
import { withTimeout } from '../util/timeout.js';
import { checkDraft } from './pipeline/ingest.js';

/**
 * The sample runs through `parse`, never `verify`: the person is trying a mapping, not a
 * signature. Nothing is stored and nothing counts against the plugin.
 */

/** JSONata has its own 2 s limit; this bounds the whole parse. */
const PARSE_TIMEOUT_MS = 5_000;
const PARSE_TIMEOUT_MESSAGE = `parse took longer than ${PARSE_TIMEOUT_MS / 1000} s`;

export interface PreviewBuilder {
  buildPreviewSource(
    typeId: string,
    settings: Record<string, unknown>,
    instanceId: string,
    name: string,
  ): Promise<
    | { ok: true; live: LiveSource }
    | { ok: false; stage: 'plugin' | 'secret' | 'create'; message: string; secretValues: string[] }
  >;
}

/** Lower-cased headers and the body's exact bytes, as the plugin would receive them. */
function sampleRequest(
  sample: SampleDeliveryDTO,
  sourceId: string,
  receivedAt: string,
): RawRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(sample.headers ?? {})) {
    if (typeof v === 'string') headers[k.toLowerCase()] = v;
  }
  if (!('content-type' in headers)) headers['content-type'] = 'application/json';
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(sample.query ?? {})) if (typeof v === 'string') query[k] = v;
  return {
    method: 'POST',
    path: `/hooks/${sourceId}`,
    headers,
    query,
    body: Buffer.from(sample.body, 'utf8'),
    receivedAt,
  };
}

async function runParse(
  live: LiveSource,
  req: RawRequest,
): Promise<{ drafts: unknown[]; notes: string[] }> {
  const { source } = live;
  if (source.parseWithNotes) {
    const report: unknown = await withTimeout(
      Promise.resolve(source.parseWithNotes(req)),
      PARSE_TIMEOUT_MS,
      PARSE_TIMEOUT_MESSAGE,
    );
    const r = (report ?? {}) as { events?: unknown; notes?: unknown };
    return {
      drafts: Array.isArray(r.events) ? (r.events as unknown[]) : [],
      notes: Array.isArray(r.notes) ? r.notes.filter((n) => typeof n === 'string') : [],
    };
  }
  if (!source.parse) throw new Error('this source type does not parse deliveries');
  const parsed: unknown = await withTimeout(
    Promise.resolve(source.parse(req)),
    PARSE_TIMEOUT_MS,
    PARSE_TIMEOUT_MESSAGE,
  );
  if (!Array.isArray(parsed)) throw new Error('parse did not return a list of events');
  return { drafts: parsed as unknown[], notes: [] };
}

/**
 * `settings` are already validated by the route. Secret values are resolved for `create` and
 * redacted from everything returned.
 */
export async function previewSourceDelivery(
  deps: Deps,
  builder: PreviewBuilder,
  input: {
    typeId: string;
    settings: Record<string, unknown>;
    sourceId: string | undefined;
    name: string;
    sample: SampleDeliveryDTO;
  },
): Promise<SourcePreviewResponse> {
  const instanceId = input.sourceId ?? 'preview';
  const built = await builder.buildPreviewSource(
    input.typeId,
    input.settings,
    instanceId,
    input.name,
  );
  if (!built.ok) {
    const message =
      built.stage === 'plugin'
        ? 'The plugin for this source type is not loaded.'
        : built.stage === 'secret'
          ? `A secret reference could not be resolved: ${built.message}`
          : `These settings do not build an instance: ${built.message}`;
    return redactSecretValues(
      { events: [], errors: [message], notes: [], declaredTypes: [] },
      built.secretValues,
    ) as SourcePreviewResponse;
  }
  const { live } = built;
  const now = deps.clock.now();
  const req = sampleRequest(input.sample, instanceId, now.toISOString());
  const errors: string[] = [];
  let drafts: unknown[] = [];
  let notes: string[] = [];
  try {
    ({ drafts, notes } = await runParse(live, req));
  } catch (err) {
    errors.push(`The sample could not be parsed: ${errorText(err)}`);
  }
  const events: SourcePreviewEvent[] = drafts.map((draft, i) => {
    const checked = checkDraft(draft, live, now);
    for (const p of checked.problems) {
      errors.push(`Event ${i + 1} (${checked.type}) would be stored as invalid: ${p}`);
    }
    return {
      type: checked.type,
      occurredAt: checked.occurredAt.toISOString(),
      artifact: checked.artifact,
      attributes: checked.attributes,
      dedupeKey: checked.dedupeKey,
      ...(checked.deliveryId !== null ? { deliveryId: checked.deliveryId } : {}),
      valid: checked.problems.length === 0,
      problems: checked.problems,
    };
  });
  return redactSecretValues(
    { events, errors, notes, declaredTypes: live.eventTypes },
    live.secretValues,
  ) as SourcePreviewResponse;
}

const SENSITIVE_HEADER = /(auth|cookie|secret|signature|token|api[-_]?key|password|session)/i;

export async function sourceForPreview(
  deps: Deps,
  sourceId: string,
): Promise<{ typeId: string; name: string; settings: Record<string, unknown> } | null> {
  const [row] = await deps.db
    .select({ typeId: sources.typeId, name: sources.name, settings: sources.settings })
    .from(sources)
    .where(eq(sources.id, sourceId));
  return row ?? null;
}

/** Only a verified push delivery with a body (not a poll page, test event or rejected delivery). */
export async function lastDelivery(
  deps: Deps,
  sourceId: string,
): Promise<LastDeliveryResponse | null> {
  const rows = await deps.db
    .select()
    .from(eventRaw)
    .where(and(eq(eventRaw.sourceId, sourceId), eq(eventRaw.verify, 'ok')))
    .orderBy(desc(eventRaw.receivedAt))
    .limit(20);
  const row = rows.find(
    (r) => r.body.length > 0 && r.headers['x-switchboard-origin'] === undefined,
  );
  if (!row) return null;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.headers)) {
    if (v === undefined) continue;
    headers[k] = SENSITIVE_HEADER.test(k) ? REDACTED : v;
  }
  return { receivedAt: row.receivedAt.toISOString(), body: row.body.toString('utf8'), headers };
}
