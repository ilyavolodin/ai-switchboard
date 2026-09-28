/**
 * The sample delivery a person pastes into the "Try it with a sample delivery" panel: as typed
 * (`SampleDraft`), as the path fields read it (`DeliverySample`) and as the preview request.
 */
import type { LastDeliveryResponse, SourcePreviewRequest } from '@ai-switchboard/core/contract';

import { parseSampleBody, type DeliverySample } from './suggest.js';

/** The panel's text fields. */
export interface SampleDraft {
  body: string;
  /** One `name: value` per line. */
  headers: string;
  /** `a=1&b=2`, with or without the leading `?`. */
  query: string;
}

export const EMPTY_SAMPLE: SampleDraft = { body: '', headers: '', query: '' };

/** `name: value` lines → lower-cased header names. Lines without a colon are ignored. */
export function headerLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (name !== '') out[name] = line.slice(i + 1).trim();
  }
  return out;
}

/** `?a=1&b=2` → `{ a: '1', b: '2' }`. */
export function queryParams(text: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(text.trim().replace(/^\?/, '')));
}

/** What path fields suggest from; `null` until a body is pasted. */
export function deliverySample(draft: SampleDraft): DeliverySample | null {
  if (draft.body.trim() === '') return null;
  return {
    body: parseSampleBody(draft.body) ?? draft.body,
    headers: headerLines(draft.headers),
    query: queryParams(draft.query),
  };
}

/** A stored delivery as panel text: the body pretty-printed when it is JSON. */
export function draftFromDelivery(last: LastDeliveryResponse): SampleDraft {
  const parsed = parseSampleBody(last.body);
  return {
    body: parsed === null ? last.body : JSON.stringify(parsed, null, 2),
    headers: Object.entries(last.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
    query: '',
  };
}

/** The preview request, or `null` while there is no body to try. */
export function previewRequest(
  typeId: string,
  settings: Record<string, unknown>,
  sourceId: string | undefined,
  draft: SampleDraft,
): SourcePreviewRequest | null {
  if (draft.body.trim() === '') return null;
  const headers = headerLines(draft.headers);
  const query = queryParams(draft.query);
  return {
    typeId,
    settings,
    ...(sourceId ? { sourceId } : {}),
    request: {
      body: draft.body,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(query).length > 0 ? { query } : {}),
    },
  };
}
