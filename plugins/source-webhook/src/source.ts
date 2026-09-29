import {
  safeEqual,
  verifyHmac,
  type EventTypeSpec,
  type PluginContext,
  type RawRequest,
  type Settings,
  type Source,
  type SourceType,
  type VerifyResult,
} from '@ai-switchboard/sdk';

import { compileJsonata } from './jsonata-mode.js';
import { compileMapped } from './mapped.js';
import type { Delivery, Mapper } from './mapper.js';
import { compileQuick } from './quick.js';
import {
  mappingModeOf,
  readSettings,
  settingsSchema,
  SOURCE_ID,
  type WebhookSettings,
} from './settings.js';

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

/** `raw` is the settings as given, before defaults. */
function compileMapper(raw: Settings, s: WebhookSettings): Mapper {
  switch (mappingModeOf(raw)) {
    case 'quick':
      return compileQuick(s);
    case 'mapped':
      return compileMapped(s.rules ?? []);
    case 'jsonata':
      return compileJsonata(s.eventTypes ?? [], s.mapping ?? '');
  }
}

function deliveryOf(req: RawRequest, s: WebhookSettings, hidden: Set<string>): Delivery {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined && !hidden.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  }
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) if (v !== undefined) query[k] = v;
  const headerDelivery = req.headers[s.deliveryIdHeader.toLowerCase()];
  return {
    body: parseBody(req),
    headers,
    query,
    raw: req.body,
    receivedAt: req.receivedAt,
    deliveryId: headerDelivery !== undefined && headerDelivery !== '' ? headerDelivery : undefined,
  };
}

function createWebhookSource(settings: Settings, ctx: PluginContext): Source {
  const s = readSettings(settings);
  const mapper = compileMapper(settings, s);
  const hidden = hiddenHeaders(s);
  const report = (req: RawRequest) => mapper.map(deliveryOf(req, s, hidden));

  const verify = makeVerify(s);
  const source: Source = {
    parse: async (req) => (await report(req)).events,
    parseWithNotes: report,
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

/** Invalid settings yield none. */
export function instanceEventTypes(settings: Settings): EventTypeSpec[] {
  try {
    return compileMapper(settings, readSettings(settings)).eventTypes;
  } catch {
    return [];
  }
}

export const webhookSource: SourceType = {
  id: SOURCE_ID,
  displayName: 'Webhook',
  icon: 'webhook',
  description:
    'Receive any JSON (or form-encoded) webhook. Start with no setup (one event per delivery, attributes from the body), or name event types and pick their fields by path, or write a JSONata mapping.',
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
