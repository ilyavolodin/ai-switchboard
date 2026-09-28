/**
 * An in-memory stand-in for the core's REST API: a `fetch` implementation backed by a handler
 * map (`'GET /board'`, `'POST /processes/:id/breaker/reset'`, ...). Tests install it with
 * `installMockApi()`; `VITE_MOCK_API=1 pnpm dev:ui` installs it in the browser so screens can be
 * built without a backend. Every request is recorded in `calls`.
 */
import type {
  ApiError,
  SourcePreviewRequest,
  SourcePreviewResponse,
} from '@ai-switchboard/core/contract';

import { at } from '../lib/at.js';
import { API_BASE } from './client.js';
import { buildFixtures, type Fixtures } from './fixtures.js';

/** What a handler sees. */
export interface MockRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

/** A handler returns a JSON body, or `{ status, body }` for errors and 204s. */
export type MockHandler = (req: MockRequest) => unknown;
export type MockHandlers = Record<string, MockHandler>;

/** Wrap a result to send a non-200 status (`mockStatus(404, {...})`, `mockStatus(204)`). */
export function mockStatus(status: number, body?: unknown): MockStatusResult {
  return { __mockStatus: status, body };
}

interface MockStatusResult {
  __mockStatus: number;
  body: unknown;
}

function isStatusResult(v: unknown): v is MockStatusResult {
  return typeof v === 'object' && v !== null && '__mockStatus' in v;
}

/** The recorded request log. */
export interface MockCall {
  method: string;
  path: string;
  body: unknown;
}

export interface MockApi {
  fetch: typeof fetch;
  calls: MockCall[];
  fixtures: Fixtures;
  /** Replace or add handlers (keys like `'GET /board'`). */
  use(handlers: MockHandlers): void;
  /** Calls whose `METHOD path` matches exactly, e.g. `callsTo('POST /sources/src-github/reload')`. */
  callsTo(route: string): MockCall[];
}

const page = <T>(items: T[]) => ({ items, nextCursor: null });

/**
 * A stand-in for `POST /sources/preview`, shaped like the webhook's quick mode: a JSON object
 * body becomes one `webhook.request.received` event with its top-level scalars as attributes.
 */
function samplePreview(body: unknown): SourcePreviewResponse {
  const req = (body ?? {}) as Partial<SourcePreviewRequest>;
  const declaredTypes: SourcePreviewResponse['declaredTypes'] = [
    {
      type: 'webhook.request.received',
      title: 'Webhook delivery',
      description: 'One event per delivery.',
      attributes: { type: 'object', properties: {} },
      examples: [{}],
    },
  ];
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.request?.body ?? '');
  } catch {
    return {
      events: [],
      errors: ['The sample could not be parsed: the body is not JSON'],
      notes: [],
      declaredTypes,
    };
  }
  const obj =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const attributes: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attributes[k] = v;
  }
  const id = typeof obj.id === 'string' || typeof obj.id === 'number' ? String(obj.id) : 'body-1';
  return {
    events: [
      {
        type: 'webhook.request.received',
        occurredAt: '2026-09-27T10:00:00.000Z',
        artifact: { kind: 'webhook.request', id },
        attributes,
        dedupeKey: `webhook.request.received:webhook.request:${id}:`,
        valid: true,
        problems: [],
      },
    ],
    errors: [],
    notes: [],
    declaredTypes,
  };
}

/** Default handlers for every route in docs/api.md, answering from fixtures. */
export function defaultHandlers(f: Fixtures): MockHandlers {
  const byId = <T extends { id: string }>(list: T[], id: string | undefined) =>
    list.find((x) => x.id === id);
  const notFound = (what: string) =>
    mockStatus(404, { error: 'not_found', message: `${what} not found` } satisfies ApiError);
  const requireReason = (req: MockRequest) => {
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    // Like the server: with `requireReasons` off, a blank reason is accepted.
    return !f.settings.requireReasons || (typeof reason === 'string' && reason.trim() !== '')
      ? null
      : mockStatus(400, { error: 'reason_required', message: 'A reason is required' });
  };
  const reasoned =
    (fn: MockHandler): MockHandler =>
    (req) =>
      requireReason(req) ?? fn(req);

  return {
    'GET /auth/me': () => f.me,
    'POST /auth/login': () => f.me,
    'POST /auth/logout': () => mockStatus(204),
    'POST /auth/password': () => ({ ...f.me, mustChangePassword: false }),
    'GET /auth/whoami': () => ({ actor: f.user.email }),

    'GET /status': () => f.status,
    'GET /board': () => f.board,
    'GET /plugin-types': (req) => {
      const kind = req.query.get('kind');
      return kind ? f.pluginTypes.filter((t) => t.kind === kind) : f.pluginTypes;
    },

    'GET /sources': () => f.sources,
    'POST /sources': reasoned(() => f.sourceDetail(at(f.sources, 1))),
    'GET /sources/:id': (r) => {
      const s = byId(f.sources, r.params.id);
      return s ? f.sourceDetail(s) : notFound('source');
    },
    'PUT /sources/:id': reasoned((r) => {
      const s = byId(f.sources, r.params.id);
      return s ? f.sourceDetail(s) : notFound('source');
    }),
    'DELETE /sources/:id': reasoned(() => mockStatus(204)),
    'POST /sources/:id/enable': reasoned((r) => {
      const s = byId(f.sources, r.params.id);
      return s ? f.sourceDetail(s) : notFound('source');
    }),
    'POST /sources/:id/provision': reasoned(() => ({ ok: true, message: 'Webhook registered' })),
    'POST /sources/:id/test-event': reasoned(() => ({ eventIds: ['ev-test-1'] })),
    'POST /sources/:id/reload': reasoned((r) => {
      const s = byId(f.sources, r.params.id);
      return s ? f.sourceDetail(s) : notFound('source');
    }),
    'GET /sources/:id/stats': (r) => ({
      ...f.sourceStats,
      window: r.query.get('window') ?? f.sourceStats.window,
    }),
    'GET /sources/:id/events': (r) => page(f.activity.filter((a) => a.sourceId === r.params.id)),
    'POST /sources/preview': (r) => samplePreview(r.body),
    'GET /sources/:id/last-delivery': (r) =>
      byId(f.sources, r.params.id) ? f.lastDelivery : notFound('source'),

    'GET /destinations': () => f.destinations,
    'POST /destinations': reasoned(() => f.destinationDetail(at(f.destinations, 0))),
    'GET /destinations/:id': (r) => {
      const x = byId(f.destinations, r.params.id);
      return x ? f.destinationDetail(x) : notFound('destination');
    },
    'PUT /destinations/:id': reasoned((r) => {
      const x = byId(f.destinations, r.params.id);
      return x ? f.destinationDetail(x) : notFound('destination');
    }),
    'DELETE /destinations/:id': reasoned(() => mockStatus(204)),
    'POST /destinations/:id/enable': reasoned((r) => {
      const x = byId(f.destinations, r.params.id);
      return x ? f.destinationDetail(x) : notFound('destination');
    }),
    'POST /destinations/:id/reload': reasoned((r) => {
      const x = byId(f.destinations, r.params.id);
      return x ? f.destinationDetail(x) : notFound('destination');
    }),
    'POST /destinations/:id/meters/read': reasoned(
      (r) => byId(f.destinations, r.params.id)?.meters ?? [],
    ),
    'POST /destinations/:id/soft-hold/clear': reasoned((r) => {
      const x = byId(f.destinations, r.params.id);
      return x ? f.destinationDetail(x) : notFound('destination');
    }),
    'GET /destinations/:id/meters': (r) => ({
      ...f.meterHistory,
      window: r.query.get('window') ?? f.meterHistory.window,
    }),
    'GET /destinations/:id/usage': (r) => ({
      ...f.usageHistory,
      window: r.query.get('window') ?? f.usageHistory.window,
    }),

    'GET /processes': () => f.processes,
    'POST /processes': reasoned(() => f.processDetail(at(f.processes, 2))),
    'POST /processes/preview/filter': () => f.filterPreview,
    'POST /processes/preview/input': () => f.inputPreview,
    'POST /processes/preview/cron': (r) => {
      const cron = (r.body as { cron?: string } | undefined)?.cron ?? '';
      return cron.trim().split(/\s+/).length === 5
        ? f.cronPreview
        : { valid: false, description: '', next: [], error: 'expected 5 fields' };
    },
    'GET /processes/:id': (r) => {
      const p = byId(f.processes, r.params.id);
      return p ? f.processDetail(p) : notFound('process');
    },
    'PUT /processes/:id': reasoned((r) => {
      const p = byId(f.processes, r.params.id);
      return p ? f.processDetail(p) : notFound('process');
    }),
    'DELETE /processes/:id': reasoned(() => mockStatus(204)),
    'POST /processes/:id/enable': reasoned((r) => {
      const p = byId(f.processes, r.params.id);
      return p ? f.processDetail(p) : notFound('process');
    }),
    'POST /processes/:id/run': reasoned(() => ({
      batchId: 'b-manual-1',
      runId: 'run_manual_1',
      outcome: 'invoked',
    })),
    'POST /processes/:id/breaker/reset': reasoned((r) => {
      const p = byId(f.processes, r.params.id);
      return p ? { ...f.processDetail(p), breakerState: 'closed' } : notFound('process');
    }),
    'GET /processes/:id/funnel': () => f.funnel,
    'GET /processes/:id/stats': () => f.processStats,
    'GET /processes/:id/versions': () => f.versions,
    'GET /processes/:id/versions/:version': (r) => {
      const v = f.versions.find((x) => String(x.version) === r.params.version);
      return v ? { ...v, document: f.versionDocument(v.version) } : notFound('version');
    },
    'POST /processes/:id/versions/:version/restore': reasoned((r) => {
      const p = byId(f.processes, r.params.id);
      return p ? f.processDetail(p) : notFound('process');
    }),
    'GET /processes/:id/batches': () => f.batches,
    'GET /processes/:id/activity': (r) =>
      page(f.activity.filter((a) => a.processes.some((p) => p.id === r.params.id))),

    'GET /events': () => page(f.activity),
    'GET /events/:id': () => f.eventDetail,
    'POST /events/:id/replay': reasoned(() => ({ eventIds: ['ev-replay-1'] })),
    'GET /events/:id/trace': () => f.trace,
    'GET /trace': (r) => ({ ...f.trace, query: r.query.get('artifact') ?? '' }),

    'GET /runs': () => page(f.runs),
    'GET /runs/:id': () => f.runDetail,
    'POST /runs/:id/close': reasoned(() => f.runDetail),

    'GET /approvals': () => f.approvals,
    'GET /approvals/history': () => page(f.approvalHistory),
    'GET /approvals/rules': () => f.approvalRules,
    'POST /approvals/:batchId/approve': reasoned(() => ({
      runId: 'run_approved_1',
      outcome: 'invoked',
    })),
    'POST /approvals/:batchId/reject': reasoned(() => mockStatus(204)),

    'GET /plugins': () => f.plugins,
    'GET /plugins/catalogue': () => f.catalogue,
    'GET /plugins/search': (r) => {
      const kind = r.query.get('kind');
      const wanted = kind === 'secrets' ? 'secret_provider' : kind;
      const q = (r.query.get('q') ?? '').trim().toLowerCase();
      return {
        registry: 'https://registry.npmjs.org',
        results: f.pluginSearch.filter(
          (p) =>
            (!wanted || p.kind === wanted) &&
            (!q || p.package.includes(q) || p.description.toLowerCase().includes(q)),
        ),
      };
    },
    'POST /plugins/inspect': (r) => ({
      package: (r.body as { package?: string } | undefined)?.package ?? '',
      version: '1.2.0',
      sdkRange: '^2.0.0',
      compatible: true,
      capabilities: { network: ['sentry.io'], secrets: ['SENTRY_*'] },
      types: [{ kind: 'source', typeId: 'sentry', displayName: 'Sentry' }],
      integrity: 'sha512-fixture',
    }),
    'POST /plugins': reasoned((r) => {
      // Installed and loaded at once: its type (named after the package) becomes available.
      const pkg = (r.body as { package?: string } | undefined)?.package ?? 'plugin';
      const m = /(source|destination|notifier|secrets)-([a-z0-9-]+)$/.exec(pkg);
      const kind = m?.[1] === 'secrets' ? 'secret_provider' : (m?.[1] ?? 'source');
      const typeId = m?.[2] ?? pkg;
      const displayName = typeId.charAt(0).toUpperCase() + typeId.slice(1);
      if (!f.pluginTypes.some((t) => t.typeId === typeId && t.kind === kind)) {
        f.pluginTypes.push({
          kind: kind as 'source',
          typeId,
          displayName,
          plugin: pkg,
          available: true,
          settingsSchema: {
            type: 'object',
            required: ['token'],
            properties: { token: { type: 'string', title: 'API token', 'x-secret': true } },
          },
          ...(kind === 'source' ? { mode: 'push' as const, eventTypes: [] } : {}),
        });
      }
      return {
        ...f.plugins[0],
        name: pkg,
        pluginId: typeId,
        displayName,
        origin: 'installed',
        types: [{ kind, typeId, displayName, instanceCount: 0 }],
        pendingRestart: false,
      };
    }),
    'DELETE /plugins/:name': reasoned(() => mockStatus(204)),

    'GET /notifiers': () => f.notifiers,
    'POST /notifiers': reasoned(() => f.notifiers[0]),
    'PUT /notifiers/:id': reasoned(() => f.notifiers[0]),
    'POST /notifiers/:id/enable': reasoned(() => f.notifiers[0]),
    'POST /notifiers/:id/reload': reasoned(() => f.notifiers[0]),
    'POST /notifiers/:id/test': reasoned(() => ({ ok: true })),
    'DELETE /notifiers/:id': reasoned(() => mockStatus(204)),
    'GET /secret-providers': () => f.secretProviders,
    'POST /secret-providers': reasoned(() => f.secretProviders[0]),
    'PUT /secret-providers/:id': reasoned(() => f.secretProviders[0]),
    'POST /secret-providers/:id/enable': reasoned(() => f.secretProviders[0]),
    'POST /secret-providers/:id/reload': reasoned(() => f.secretProviders[0]),
    'DELETE /secret-providers/:id': reasoned(() => mockStatus(204)),
    'GET /secret-providers/:id/secrets': (req) =>
      f.providerSecrets[req.params.id ?? ''] ?? notFound('Secret provider'),

    'GET /settings': () => f.settings,
    'PUT /settings': reasoned(() => f.settings),
    'GET /users': () => f.users,
    'GET /users/directory': () => f.users.map(({ id, email, role }) => ({ id, email, role })),
    'POST /users': reasoned(() => f.users[1]),
    'PUT /users/:id': reasoned(() => f.users[1]),
    'DELETE /users/:id': reasoned(() => mockStatus(204)),
    'POST /users/:id/sessions/revoke': reasoned(() => mockStatus(204)),
    'PUT /users/:id/password': reasoned((req) => {
      const u = byId(f.users, req.params.id);
      return u ? { ...u, hasPassword: true, mustChangePassword: true } : notFound('User');
    }),
    'DELETE /users/:id/password': reasoned((req) => {
      const u = byId(f.users, req.params.id);
      return u ? { ...u, hasPassword: false, mustChangePassword: false } : notFound('User');
    }),
    'GET /tokens': () => f.tokens,
    'POST /tokens': reasoned((r) => {
      const body = r.body as { name?: string; role?: string } | undefined;
      return {
        token: { ...at(f.tokens, 0), id: 'tok-new', name: body?.name, role: body?.role },
        secret: 'sb_fixture-secret',
      };
    }),
    'DELETE /tokens/:id': reasoned(() => mockStatus(204)),
    'GET /audit': () => page(f.audit),
    'GET /export': () => 'processes: []\n',
    'POST /apply': (r) => ({
      dryRun: Boolean((r.body as { dryRun?: boolean } | undefined)?.dryRun),
      changes: [],
      errors: [],
    }),
    'GET /about': () => f.about,
  };
}

interface CompiledRoute {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: MockHandler;
  specificity: number;
}

function compile(key: string, handler: MockHandler): CompiledRoute {
  const [method = 'GET', path = '/'] = key.split(' ');
  const names: string[] = [];
  const source = path
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        names.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return {
    method,
    pattern: new RegExp(`^${source}$`),
    names,
    handler,
    specificity: path.split('/').filter((p) => p && !p.startsWith(':')).length,
  };
}

/**
 * Creates a mock API. `overrides` replace default handlers by key. `delayMs` simulates latency.
 */
export function createMockApi(
  options: { fixtures?: Fixtures; overrides?: MockHandlers; delayMs?: number } = {},
): MockApi {
  const fixtures = options.fixtures ?? buildFixtures(Date.now());
  let handlers: MockHandlers = { ...defaultHandlers(fixtures), ...options.overrides };
  let routes = Object.entries(handlers).map(([k, h]) => compile(k, h));
  const calls: MockCall[] = [];

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.startsWith(API_BASE)
      ? url.pathname.slice(API_BASE.length)
      : url.pathname;
    const body: unknown =
      typeof init?.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));

    const match = routes
      .filter((r) => r.method === method && r.pattern.test(path))
      .sort((a, b) => b.specificity - a.specificity)[0];
    if (!match) {
      return json(404, { error: 'not_found', message: `No mock for ${method} ${path}` });
    }
    const values = match.pattern.exec(path)?.slice(1) ?? [];
    const params: Record<string, string> = {};
    match.names.forEach((n, i) => {
      params[n] = decodeURIComponent(values[i] ?? '');
    });
    const result = await match.handler({ method, path, params, query: url.searchParams, body });
    if (isStatusResult(result)) {
      if (result.__mockStatus === 204) return new Response(null, { status: 204 });
      return json(result.__mockStatus, result.body);
    }
    if (typeof result === 'string') {
      return new Response(result, { status: 200, headers: { 'content-type': 'text/yaml' } });
    }
    return json(200, result);
  };

  return {
    fetch: mockFetch,
    calls,
    fixtures,
    use(more) {
      handlers = { ...handlers, ...more };
      routes = Object.entries(handlers).map(([k, h]) => compile(k, h));
    },
    callsTo(route) {
      const [method, path] = route.split(' ');
      return calls.filter((c) => c.method === method && c.path === path);
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
