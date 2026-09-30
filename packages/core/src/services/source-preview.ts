import { secretPaths, type RawRequest } from '@ai-switchboard/sdk';
import { and, desc, eq } from 'drizzle-orm';

import type {
  LastDeliveryResponse,
  SampleDeliveryDTO,
  SourcePreviewEvent,
  SourcePreviewRequest,
  SourcePreviewResponse,
} from '../contract/index.js';
import { eventRaw, sources } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { checkDraft } from '../pipeline/door.js';
import type { LiveSource } from '../plugins/runtime.js';
import { isSecretRef, REDACTED, redactSecretValues } from '../secrets/refs.js';
import { errorText } from '../util/errors.js';
import { withTimeout } from '../util/timeout.js';
import { isUuid } from '../util/uuid.js';
import { isServiceError, notFound, ServiceError, unprocessable } from './errors.js';
import { validateSettings } from './instance-validation.js';

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

function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split('.')) {
    cur =
      cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
  }
  return cur;
}

function setPath(value: Record<string, unknown>, path: string, next: unknown): void {
  const keys = path.split('.');
  let cur: Record<string, unknown> = value;
  for (const key of keys.slice(0, -1)) {
    const child = cur[key];
    if (child === null || typeof child !== 'object') cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  const last = keys.at(-1);
  if (last !== undefined) cur[last] = next;
}

function emptyPreview(errors: string[]): SourcePreviewResponse {
  return { events: [], errors, notes: [], declaredTypes: [] };
}

/**
 * `POST /sources/preview`: draft settings (for an existing source, a secret field left empty
 * keeps its stored reference, as a save would) and a sample delivery. Settings that do not
 * validate are reported in `errors`, not refused.
 */
export async function previewSource(
  deps: Deps,
  builder: PreviewBuilder,
  request: SourcePreviewRequest,
): Promise<SourcePreviewResponse> {
  const { typeId, sourceId } = request;
  const entry = deps.runtime.sourceType(typeId);
  if (!entry) throw notFound(`Source type ${typeId}`);
  if (entry.type.mode === 'pull') {
    throw unprocessable(
      `${entry.type.displayName} sources are polled, not pushed: there is no delivery to preview.`,
    );
  }
  const draft = structuredClone(request.settings);
  let name = `${entry.type.displayName} preview`;
  if (sourceId !== undefined) {
    const stored = isUuid(sourceId) ? await sourceForPreview(deps, sourceId) : null;
    if (!stored) throw notFound(`Source ${sourceId}`);
    if (stored.typeId !== typeId) {
      throw unprocessable(`Source ${stored.name} is a ${stored.typeId} source, not ${typeId}.`);
    }
    name = stored.name;
    for (const path of secretPaths(entry.type.settingsSchema)) {
      const given = getPath(draft, path);
      const kept = getPath(stored.settings, path);
      if ((given === undefined || given === '') && isSecretRef(kept)) setPath(draft, path, kept);
    }
  }
  let settings: Record<string, unknown>;
  try {
    settings = validateSettings(entry.type.settingsSchema, draft);
  } catch (err) {
    if (!isServiceError(err)) throw err;
    // "must match \"then\" schema" only repeats the branch's own messages.
    const details = (err.details ?? [err.message]).filter(
      (d) => !/must match "(then|else)" schema$/.test(d),
    );
    return emptyPreview(details.map((d) => `Settings: ${d.replace(/^\(root\) /, '')}`));
  }
  return previewSourceDelivery(deps, builder, {
    typeId,
    settings,
    sourceId,
    name,
    sample: request.request,
  });
}

/** `settings` are already validated. Secret values are resolved for `create` and redacted from everything returned. */
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
  const row = rows.find((r) => r.body.length > 0 && r.origin === 'push');
  if (!row) return null;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.headers)) {
    if (v === undefined) continue;
    headers[k] = SENSITIVE_HEADER.test(k) ? REDACTED : v;
  }
  return { receivedAt: row.receivedAt.toISOString(), body: row.body.toString('utf8'), headers };
}

/** `GET /sources/:id/last-delivery`: a 404 for an unknown source or one with nothing stored. */
export async function lastDeliveryOf(deps: Deps, sourceId: string): Promise<LastDeliveryResponse> {
  if (!isUuid(sourceId) || !(await sourceForPreview(deps, sourceId)))
    throw notFound(`Source ${sourceId}`);
  const last = await lastDelivery(deps, sourceId);
  if (!last) throw new ServiceError(404, 'not_found', 'This source has no stored delivery yet.');
  return last;
}
