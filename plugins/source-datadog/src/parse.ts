import {
  draftFromMapped,
  parseJsonObject,
  toIsoTime,
  type ArtifactRef,
  type Attributes,
  type EventDraft,
  type JsonObject,
  type RawRequest,
} from '@ai-switchboard/sdk';

export type MonitorVerb = 'triggered' | 'recovered' | 'warn' | 'no_data' | 'renotify';

/**
 * Datadog's `$ALERT_TRANSITION` to an event verb. Re-notifications of any state are `renotify`;
 * anything unrecognised is treated as `triggered` so a new Datadog value is never silently
 * dropped (the raw value stays in the `transition` attribute for filters).
 */
export function transitionVerb(transition: string): MonitorVerb {
  const t = transition
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ');
  if (t.startsWith('re-') || t.startsWith('re ') || t === 'renotify' || t === 'renotified')
    return 'renotify';
  if (t.includes('recover')) return 'recovered';
  if (t === 'no data' || t === 'nodata') return 'no_data';
  if (t === 'warn' || t === 'warning') return 'warn';
  return 'triggered';
}

/**
 * A template value, or `undefined` when it is empty or Datadog left the variable unsubstituted
 * (`"$HOSTNAME"` when the monitor has no host).
 */
function field(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  const s =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : undefined;
  if (s === undefined || s === '' || /^\$[A-Z_]+$/.test(s)) return undefined;
  return s;
}

/** `$TAGS` is a comma-separated list: `env:prod,service:api`. */
export function splitTags(tags: string | undefined): string[] {
  if (tags === undefined) return [];
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

const OPTIONAL: [attribute: string, key: string][] = [
  ['alertType', 'alertType'],
  ['priority', 'priority'],
  ['hostname', 'hostname'],
  ['metric', 'metric'],
  ['scope', 'scope'],
  ['orgId', 'orgId'],
];

/** Maps one delivery of the README's payload template. Pure. */
export function parseDelivery(req: RawRequest): EventDraft[] {
  const body = parseJsonObject(req.body.toString('utf8'));
  if (!body) return [];
  const monitorId = field(body, 'alertId');
  const transition = field(body, 'transition');
  if (monitorId === undefined || transition === undefined) return [];
  const type = `datadog.monitor.${transitionVerb(transition)}`;
  // No version: a monitor has none. The alert cycle key collapses redeliveries (and repeats)
  // within one alert cycle while a new cycle yields a new key.
  const artifact: ArtifactRef = { kind: 'datadog.monitor', id: monitorId };
  const link = field(body, 'link');
  if (link !== undefined) artifact.url = link;
  const deliveryId = field(body, 'alertCycleKey') ?? field(body, 'id');

  const attributes: Attributes = {
    monitorId,
    title: field(body, 'title') ?? '',
    transition,
    tags: splitTags(field(body, 'tags')),
  };
  for (const [attribute, key] of OPTIONAL) {
    const value = field(body, key);
    if (value !== undefined) attributes[attribute] = value;
  }
  // `$DATE` / `$LAST_UPDATED` are epoch milliseconds (seconds tolerated) or ISO strings.
  const occurredAt = toIsoTime(field(body, 'date')) ?? toIsoTime(field(body, 'lastUpdated'));
  return [
    draftFromMapped(
      { type, artifact, attributes, occurredAt, deliveryId },
      { occurredAt: req.receivedAt },
    ),
  ];
}
