import {
  dedupeKey,
  safeEqual,
  verifyHmac,
  type EventDraft,
  type EventTypeSpec,
  type PluginContext,
  type RawRequest,
  type Settings,
  type Source,
  type SourceType,
  type VerifyResult,
} from '@ai-switchboard/sdk';

import { compileEventTypes, narrowMapped } from './event-types.js';
import { asList, compileExpression } from './mapping.js';
import { readSettings, settingsSchema, type WebhookSettings } from './settings.js';

/** Headers never handed to the mapping, so a mapping cannot copy a credential into attributes. */
const ALWAYS_HIDDEN = ['authorization', 'cookie', 'proxy-authorization'];

function hiddenHeaders(s: WebhookSettings): Set<string> {
  return new Set(
    [...ALWAYS_HIDDEN, s.signatureHeader, s.sharedSecretHeader].map((h) => h.toLowerCase()),
  );
}

function parseBody(req: RawRequest): unknown {
  const text = req.body.toString('utf8');
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function makeVerify(s: WebhookSettings): ((req: RawRequest) => VerifyResult) | undefined {
  const secret = s.secret ?? '';
  switch (s.verification) {
    case 'none':
      return undefined;
    case 'hmac': {
      const header = s.signatureHeader.toLowerCase();
      return (req) => {
        const signature = req.headers[header];
        if (signature === undefined || signature === '') {
          return { ok: false, reason: `missing ${header} header` };
        }
        const ok = verifyHmac({
          secret,
          payload: req.body,
          algorithm: s.algorithm,
          encoding: s.signatureEncoding,
          signature,
          prefix: s.signaturePrefix,
        });
        return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
      };
    }
    case 'shared_secret': {
      const header = s.sharedSecretHeader.toLowerCase();
      return (req) => {
        const given = req.headers[header];
        if (given === undefined || given === '') {
          return { ok: false, reason: `missing ${header} header` };
        }
        return safeEqual(given, secret) ? { ok: true } : { ok: false, reason: 'secret mismatch' };
      };
    }
  }
}

function createWebhookSource(settings: Settings, ctx: PluginContext): Source {
  const s = readSettings(settings);
  const types = compileEventTypes(s.eventTypes);
  const mapping = compileExpression(s.mapping, 'mapping');
  const hidden = hiddenHeaders(s);
  const deliveryHeader = s.deliveryIdHeader.toLowerCase();

  const parse = async (req: RawRequest): Promise<EventDraft[]> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !hidden.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
    }
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (v !== undefined) query[k] = v;
    const result = await mapping.evaluate({ body: parseBody(req), headers, query }, req.receivedAt);
    const headerDelivery = req.headers[deliveryHeader];
    const events: EventDraft[] = [];
    for (const item of asList(result)) {
      const mapped = narrowMapped(item, types);
      if (!mapped) continue;
      const deliveryId =
        mapped.deliveryId ??
        (headerDelivery !== undefined && headerDelivery !== '' ? headerDelivery : undefined);
      events.push({
        type: mapped.type,
        occurredAt: mapped.occurredAt ?? req.receivedAt,
        artifact: mapped.artifact,
        attributes: mapped.attributes,
        dedupeKey: dedupeKey(mapped.type, mapped.artifact, deliveryId),
        ...(deliveryId !== undefined ? { deliveryId } : {}),
      });
    }
    return events;
  };

  const verify = makeVerify(s);
  const source: Source = {
    parse,
    health: () =>
      Promise.resolve({
        status: 'unknown',
        message: 'A push-only webhook has nothing to check; see the instance’s recent events.',
        checkedAt: ctx.now().toISOString(),
      }),
  };
  // Leaving `verify` off (rather than a verify that always passes) is how the core knows the
  // instance is unauthenticated.
  if (verify) source.verify = verify;
  return source;
}

/** The instance's event types, compiled from its settings. Invalid settings yield none. */
export function instanceEventTypes(settings: Settings): EventTypeSpec[] {
  try {
    return [...compileEventTypes(readSettings(settings).eventTypes).values()].map((t) => t.spec);
  } catch {
    return [];
  }
}

export const webhookSource: SourceType = {
  id: 'webhook',
  displayName: 'Webhook',
  description:
    'Receive any JSON (or form-encoded) webhook. You name the event types and write a JSONata mapping from the delivery to type, artifact and attributes.',
  mode: 'push',
  settingsSchema,
  dynamicEventTypes: true,
  allowsUnauthenticated: true,
  eventTypes: [
    {
      type: 'webhook.event.received',
      title: 'Webhook event (template)',
      description:
        'Template only. Each webhook instance declares its own event types (`webhook.<object>.<verb>`) in its settings.',
      attributes: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'A short summary.' } },
        additionalProperties: false,
      },
      examples: [{ summary: 'deploy of api finished' }],
    },
  ],
  instanceEventTypes,
  create: createWebhookSource,
};
