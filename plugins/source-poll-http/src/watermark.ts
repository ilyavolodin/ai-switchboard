import type { EventDraft } from '@ai-switchboard/sdk';

const MAX_SEEN = 500;

/**
 * The stored watermark. `cursor` is what the endpoint receives; `at` is the latest `occurredAt`
 * emitted so far and `seen` the dedupe keys emitted at exactly that instant, so items that share
 * the boundary timestamp are neither lost nor emitted twice.
 */
export interface WatermarkState {
  cursor: string | null;
  at: string | null;
  seen: string[];
}

function asTimestamp(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '' || /^\d+$/.test(value.trim())) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A plain cursor string (the initial watermark, or one set by hand) as a state. */
function fromPlain(cursor: string | null | undefined): WatermarkState {
  const c = cursor == null || cursor === '' ? null : cursor;
  return { cursor: c, at: asTimestamp(c), seen: [] };
}

export function decodeWatermark(
  watermark: string | null,
  initial: string | undefined,
): WatermarkState {
  if (watermark == null || watermark === '') return fromPlain(initial);
  try {
    const parsed = JSON.parse(watermark) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'v' in parsed && parsed.v === 1) {
      const p = parsed as { cursor?: unknown; at?: unknown; seen?: unknown };
      return {
        cursor: typeof p.cursor === 'string' ? p.cursor : null,
        at: typeof p.at === 'string' ? p.at : null,
        seen: Array.isArray(p.seen) ? p.seen.filter((k): k is string => typeof k === 'string') : [],
      };
    }
  } catch {
    // Not ours: treat it as a plain cursor below.
  }
  return fromPlain(watermark);
}

export function encodeWatermark(state: WatermarkState): string {
  return JSON.stringify({ v: 1, cursor: state.cursor, at: state.at, seen: state.seen });
}

/**
 * Keep only events after the watermark (and not emitted at the boundary instant already), in
 * `occurredAt` order, without in-batch duplicates. Returns them with the advanced boundary.
 */
export function selectNew(
  events: EventDraft[],
  state: WatermarkState,
): { events: EventDraft[]; at: string | null; seen: string[] } {
  const seenAtBoundary = new Set(state.seen);
  const emitted = new Set<string>();
  const fresh: EventDraft[] = [];
  const ordered = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (const ev of ordered) {
    if (emitted.has(ev.dedupeKey)) continue;
    if (state.at !== null) {
      if (ev.occurredAt < state.at) continue;
      if (ev.occurredAt === state.at && seenAtBoundary.has(ev.dedupeKey)) continue;
    }
    emitted.add(ev.dedupeKey);
    fresh.push(ev);
  }
  const last = fresh.at(-1);
  if (!last) return { events: fresh, at: state.at, seen: state.seen };
  const at = state.at !== null && state.at > last.occurredAt ? state.at : last.occurredAt;
  const boundary = fresh.filter((e) => e.occurredAt === at).map((e) => e.dedupeKey);
  const seen = at === state.at ? [...state.seen, ...boundary] : boundary;
  return { events: fresh, at, seen: seen.slice(-MAX_SEEN) };
}
