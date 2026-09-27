import {
  compileEventTypes,
  dedupeKey,
  narrowMapped,
  type EventDraft,
  type EventTypeSpec,
  type Health,
  type HttpRequest,
  type HttpResponse,
  type PluginContext,
  type PollResult,
  type Settings,
  type Source,
  type SourceType,
} from '@ai-switchboard/sdk';

import { asList, compileExpression } from './mapping.js';
import { readSettings, settingsSchema, SOURCE_ID, type PollHttpSettings } from './settings.js';
import { decodeWatermark, encodeWatermark, selectNew } from './watermark.js';

/** Thrown by `poll` when the endpoint refuses or answers with something that is not JSON. */
export class PollError extends Error {
  override readonly name = 'PollError';
}

function authHeaders(s: PollHttpSettings): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...s.headers };
  if (s.token !== undefined && s.token !== '') {
    const header = s.tokenHeader.toLowerCase();
    const scheme = s.authScheme.trim();
    headers[header] =
      header === 'authorization' && scheme !== '' ? `${scheme} ${s.token}` : s.token;
  }
  return headers;
}

function buildRequest(s: PollHttpSettings, cursor: string | null): HttpRequest {
  const req: HttpRequest = { method: s.method, url: s.url, headers: authHeaders(s) };
  const param = s.cursorParam;
  const withCursor = param !== undefined && param !== '' && cursor !== null;
  if (withCursor && s.cursorIn === 'query') req.query = { [param]: cursor };
  if (s.method === 'POST') {
    req.json =
      withCursor && s.cursorIn === 'body' ? { ...s.body, [param]: cursor } : (s.body ?? {});
  }
  return req;
}

function readJson(res: HttpResponse, host: string): unknown {
  if (!res.ok) throw new PollError(`${host} answered ${res.status}`);
  const text = res.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PollError(`${host} did not answer with JSON`);
  }
}

function createPollSource(settings: Settings, ctx: PluginContext): Source {
  const s = readSettings(settings);
  const types = compileEventTypes(SOURCE_ID, s.eventTypes);
  const itemsExpr = compileExpression(s.itemsExpression, 'items expression');
  const mapping = compileExpression(s.mapping, 'mapping');
  const cursorExpr =
    s.cursorExpression !== undefined && s.cursorExpression.trim() !== ''
      ? compileExpression(s.cursorExpression, 'cursor expression')
      : undefined;
  const host = new URL(s.url).hostname;

  async function poll(watermark: string | null): Promise<PollResult> {
    const state = decodeWatermark(watermark, s.initialWatermark);
    const res = await ctx.http.request(buildRequest(s, state.cursor));
    const body = readJson(res, host);
    const response = { status: res.status, headers: res.headers, body };
    // One instant per poll: `$now()` in every expression and the default `occurredAt` agree.
    const pollTime = ctx.now().toISOString();
    const items = asList(await itemsExpr.evaluate(body, pollTime));

    const drafts: EventDraft[] = [];
    for (const item of items) {
      for (const result of asList(await mapping.evaluate({ item, response }, pollTime))) {
        const mapped = narrowMapped(result, types);
        if (!mapped) continue;
        const occurredAt = mapped.occurredAt ?? pollTime;
        drafts.push({
          type: mapped.type,
          occurredAt,
          artifact: mapped.artifact,
          attributes: mapped.attributes,
          // Without a version or delivery id, the item's time tells two changes apart.
          dedupeKey: dedupeKey(mapped.type, mapped.artifact, mapped.deliveryId ?? occurredAt),
          ...(mapped.deliveryId !== undefined ? { deliveryId: mapped.deliveryId } : {}),
        });
      }
    }

    const selected = selectNew(drafts, state);
    let cursor = selected.at ?? state.cursor;
    if (cursorExpr) {
      const next = await cursorExpr.evaluate(
        { response, items, watermark: state.cursor },
        pollTime,
      );
      if (typeof next === 'string' && next !== '') cursor = next;
      else if (typeof next === 'number' && Number.isFinite(next)) cursor = String(next);
      else cursor = state.cursor;
    }
    return {
      events: selected.events,
      watermark: encodeWatermark({ cursor, at: selected.at, seen: selected.seen }),
    };
  }

  async function health(): Promise<Health> {
    const checkedAt = ctx.now().toISOString();
    if (s.healthUrl === undefined) {
      return { status: 'unknown', message: 'No health URL configured.', checkedAt };
    }
    try {
      const res = await ctx.http.get(s.healthUrl, { headers: authHeaders(s) });
      return res.ok
        ? { status: 'healthy', checkedAt }
        : { status: 'unhealthy', message: `Health URL answered ${res.status}`, checkedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'unhealthy', message, checkedAt };
    }
  }

  return { poll, health };
}

/** The instance's event types, compiled from its settings. Invalid settings yield none. */
export function instanceEventTypes(settings: Settings): EventTypeSpec[] {
  try {
    return [...compileEventTypes(SOURCE_ID, readSettings(settings).eventTypes).values()].map(
      (t) => t.spec,
    );
  } catch {
    return [];
  }
}

export const pollHttpSource: SourceType = {
  id: SOURCE_ID,
  displayName: 'HTTP poll',
  description:
    'Poll any JSON endpoint on a schedule with a cursor parameter and map its items to events with JSONata.',
  mode: 'pull',
  settingsSchema,
  dynamicEventTypes: true,
  eventTypes: [
    {
      type: 'poll-http.item.found',
      title: 'Polled item (template)',
      description:
        'Template only. Each poll-http instance declares its own event types (`poll-http.<object>.<verb>`) in its settings.',
      attributes: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'A short summary.' } },
        additionalProperties: false,
      },
      examples: [{ summary: 'incident INC-204 opened' }],
    },
  ],
  instanceEventTypes,
  create: createPollSource,
};
