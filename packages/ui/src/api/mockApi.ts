// An in-memory `fetch` for the core's REST API, for tests and `VITE_MOCK_API=1 pnpm dev:ui`.
import type {
  ApiError,
  InstanceSummary,
  PluginKind,
  SourcePreviewRequest,
  SourcePreviewResponse,
} from '@ai-switchboard/core/contract';

import { at } from '../lib/at.js';
import { API_BASE, type Route, type RouteBody, type RouteRes } from './client.js';
import { buildFixtures, type Fixtures } from './fixtures.js';

export interface MockRequest<R extends Route = Route> {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: RouteBody<R> | undefined;
}

/** Returns the route's response (a string for YAML), or `mockStatus()` for errors and 204s. */
export type MockHandler<R extends Route = Route> = (
  req: MockRequest<R>,
) => RouteRes<R> | MockStatusResult | Promise<RouteRes<R> | MockStatusResult>;
export type MockHandlers = { [R in Route]?: MockHandler<R> };

export function mockStatus(status: number, body?: unknown): MockStatusResult {
  return { __mockStatus: status, body };
}

export interface MockStatusResult {
  __mockStatus: number;
  body: unknown;
}

function isStatusResult(v: unknown): v is MockStatusResult {
  return typeof v === 'object' && v !== null && '__mockStatus' in v;
}

export interface MockCall {
  method: string;
  path: string;
  body: unknown;
}

export interface MockApi {
  fetch: typeof fetch;
  calls: MockCall[];
  fixtures: Fixtures;
  use(handlers: MockHandlers): void;
  callsTo(route: string): MockCall[];
}

const page = <T>(items: T[]) => ({ items, nextCursor: null });

/** The body minus what the server never stores. */
function patchOf(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {};
  const { reason: _reason, expectedVersion: _version, ...rest } = body as Record<string, unknown>;
  return rest;
}

/**
 * Detail rows keyed by id: a PUT or POST merges its body into the row and echoes it, and the
 * summary list picks up the fields it shares with the detail.
 */
function entityStore<S extends { id: string }, D extends { id: string }>(
  list: S[],
  detail: (s: S) => D,
) {
  const saved = new Map<string, D>();
  let created = 0;
  const get = (id: string | undefined): D | undefined => {
    const s = list.find((x) => x.id === id);
    return s ? (saved.get(s.id) ?? detail(s)) : undefined;
  };
  const write = (next: D): D => {
    saved.set(next.id, next);
    const i = list.findIndex((x) => x.id === next.id);
    const current = list[i];
    const fields = next as unknown as Record<string, unknown>;
    if (current) {
      const shared = Object.keys(current).filter((k) => k in fields);
      list[i] = { ...current, ...Object.fromEntries(shared.map((k) => [k, fields[k]])) };
    } else {
      list.push(next as unknown as S);
    }
    return next;
  };
  return {
    get,
    patch(id: string | undefined, patch: Partial<D>): D | undefined {
      const current = get(id);
      return current ? write({ ...current, ...patch }) : undefined;
    },
    create(prefix: string, template: D, patch: Partial<D>): D {
      created += 1;
      return write({ ...template, ...patch, id: `${prefix}-new-${String(created)}` });
    },
    /** `false` when there was no such row. */
    remove(id: string | undefined): boolean {
      const i = list.findIndex((x) => x.id === id);
      if (i === -1 || id === undefined) return false;
      list.splice(i, 1);
      saved.delete(id);
      return true;
    },
  };
}

/** Like the webhook's quick mode: a JSON object body becomes one event, its scalars as attributes. */
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

export function defaultHandlers(f: Fixtures): MockHandlers {
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
    <R extends Route>(fn: MockHandler<R>): MockHandler<R> =>
    (req) =>
      requireReason(req) ?? fn(req);
  const orNotFound = <T>(what: string, value: T | undefined) => value ?? notFound(what);
  const deleted = (what: string, removed: boolean) => (removed ? mockStatus(204) : notFound(what));

  const sources = entityStore(f.sources, f.sourceDetail);
  const destinations = entityStore(f.destinations, f.destinationDetail);
  const processes = entityStore(f.processes, f.processDetail);
  const notifiers = entityStore(f.notifiers, (x: InstanceSummary) => x);
  const providers = entityStore(f.secretProviders, (x: InstanceSummary) => x);
  const users = entityStore(f.users, (x) => x);
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
    'POST /sources': reasoned((r) =>
      sources.create('src', f.sourceDetail(at(f.sources, 0)), patchOf(r.body)),
    ),
    'GET /sources/:id': (r) => orNotFound('source', sources.get(r.params.id)),
    'PUT /sources/:id': reasoned((r) =>
      orNotFound('source', sources.patch(r.params.id, patchOf(r.body))),
    ),
    'DELETE /sources/:id': reasoned((r) => deleted('source', sources.remove(r.params.id))),
    'POST /sources/:id/enable': reasoned((r) =>
      orNotFound('source', sources.patch(r.params.id, patchOf(r.body))),
    ),
    'POST /sources/:id/provision': reasoned(() => ({ ok: true, message: 'Webhook registered' })),
    'POST /sources/:id/test-event': reasoned(() => ({ eventIds: ['ev-test-1'] })),
    'POST /sources/:id/reload': reasoned((r) => orNotFound('source', sources.get(r.params.id))),
    'GET /sources/:id/stats': (r) => ({
      ...f.sourceStats,
      window: (r.query.get('window') as typeof f.sourceStats.window | null) ?? f.sourceStats.window,
    }),
    'GET /sources/:id/events': (r) => page(f.activity.filter((a) => a.sourceId === r.params.id)),
    'POST /sources/preview': (r) => samplePreview(r.body),
    'GET /sources/:id/last-delivery': (r) =>
      sources.get(r.params.id) ? f.lastDelivery : notFound('source'),

    'GET /destinations': () => f.destinations,
    'POST /destinations': reasoned((r) =>
      destinations.create('dst', f.destinationDetail(at(f.destinations, 0)), patchOf(r.body)),
    ),
    'GET /destinations/:id': (r) => orNotFound('destination', destinations.get(r.params.id)),
    'PUT /destinations/:id': reasoned((r) =>
      orNotFound('destination', destinations.patch(r.params.id, patchOf(r.body))),
    ),
    'DELETE /destinations/:id': reasoned((r) =>
      deleted('destination', destinations.remove(r.params.id)),
    ),
    'POST /destinations/:id/enable': reasoned((r) =>
      orNotFound('destination', destinations.patch(r.params.id, patchOf(r.body))),
    ),
    'POST /destinations/:id/reload': reasoned((r) =>
      orNotFound('destination', destinations.get(r.params.id)),
    ),
    'POST /destinations/:id/meters/read': reasoned(
      (r) => destinations.get(r.params.id)?.meters ?? [],
    ),
    'POST /destinations/:id/soft-hold/clear': reasoned((r) =>
      orNotFound('destination', destinations.get(r.params.id)),
    ),
    'GET /destinations/:id/meters': (r) => ({
      ...f.meterHistory,
      window:
        (r.query.get('window') as typeof f.meterHistory.window | null) ?? f.meterHistory.window,
    }),
    'GET /destinations/:id/usage': (r) => ({
      ...f.usageHistory,
      window:
        (r.query.get('window') as typeof f.usageHistory.window | null) ?? f.usageHistory.window,
    }),

    'GET /processes': () => f.processes,
    'POST /processes': reasoned((r) => {
      const document = r.body?.document ?? f.autofixDocument;
      return processes.create('p', f.processDetail(at(f.processes, 0)), {
        document,
        name: document.name,
        enabled: document.enabled,
        version: 1,
      });
    }),
    'POST /processes/preview/filter': () => f.filterPreview,
    'POST /processes/preview/input': () => f.inputPreview,
    'POST /processes/preview/cron': (r) => {
      const cron = r.body?.cron ?? '';
      return cron.trim().split(/\s+/).length === 5
        ? f.cronPreview
        : { valid: false, description: '', next: [], error: 'expected 5 fields' };
    },
    'GET /processes/:id': (r) => orNotFound('process', processes.get(r.params.id)),
    'PUT /processes/:id': reasoned((r) => {
      const current = processes.get(r.params.id);
      if (!current) return notFound('process');
      const document = r.body?.document ?? current.document;
      return orNotFound(
        'process',
        processes.patch(r.params.id, {
          document,
          name: document.name,
          enabled: document.enabled,
          version: current.version + 1,
        }),
      );
    }),
    'DELETE /processes/:id': reasoned((r) => deleted('process', processes.remove(r.params.id))),
    'POST /processes/:id/enable': reasoned((r) => {
      const current = processes.get(r.params.id);
      if (!current) return notFound('process');
      const enabled = r.body?.enabled ?? current.enabled;
      return orNotFound(
        'process',
        processes.patch(r.params.id, { enabled, document: { ...current.document, enabled } }),
      );
    }),
    'POST /processes/:id/run': reasoned(() => ({
      batchId: 'b-manual-1',
      runId: 'run_manual_1',
      outcome: 'invoked',
    })),
    'POST /processes/:id/breaker/reset': reasoned((r) =>
      orNotFound('process', processes.patch(r.params.id, { breakerState: 'closed' })),
    ),
    'GET /processes/:id/funnel': () => f.funnel,
    'GET /processes/:id/stats': () => f.processStats,
    'GET /processes/:id/versions': () => f.versions,
    'GET /processes/:id/versions/:version': (r) => {
      const v = f.versions.find((x) => String(x.version) === r.params.version);
      return v ? { ...v, document: f.versionDocument(v.version) } : notFound('version');
    },
    'POST /processes/:id/versions/:version/restore': reasoned((r) =>
      orNotFound('process', processes.get(r.params.id)),
    ),
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
    'POST /runs/:id/close': reasoned((r) => {
      const status = r.body?.status ?? f.runDetail.status;
      f.runDetail = { ...f.runDetail, status };
      return f.runDetail;
    }),

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
      package: r.body?.package ?? '',
      version: '1.2.0',
      sdkRange: '^2.0.0',
      compatible: true,
      capabilities: { network: ['sentry.io'], secrets: ['SENTRY_*'] },
      types: [{ kind: 'source', typeId: 'sentry', displayName: 'Sentry' }],
      integrity: 'sha512-fixture',
    }),
    'POST /plugins': reasoned((r) => {
      // Installed and loaded at once: its type (named after the package) becomes available.
      const pkg = r.body?.package ?? 'plugin';
      const m = /(source|destination|notifier|secrets)-([a-z0-9-]+)$/.exec(pkg);
      const kind = (m?.[1] === 'secrets' ? 'secret_provider' : (m?.[1] ?? 'source')) as PluginKind;
      const typeId = m?.[2] ?? pkg;
      const displayName = typeId.charAt(0).toUpperCase() + typeId.slice(1);
      if (!f.pluginTypes.some((t) => t.typeId === typeId && t.kind === kind)) {
        f.pluginTypes.push({
          kind: kind,
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
        ...at(f.plugins, 0),
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
    'POST /notifiers': reasoned((r) =>
      notifiers.create('nt', at(f.notifiers, 0), { ...patchOf(r.body), kind: 'notifier' }),
    ),
    'PUT /notifiers/:id': reasoned((r) =>
      orNotFound('notifier', notifiers.patch(r.params.id, patchOf(r.body))),
    ),
    'POST /notifiers/:id/enable': reasoned((r) =>
      orNotFound('notifier', notifiers.patch(r.params.id, patchOf(r.body))),
    ),
    'POST /notifiers/:id/reload': reasoned((r) =>
      orNotFound('notifier', notifiers.get(r.params.id)),
    ),
    'POST /notifiers/:id/test': reasoned(() => ({ ok: true, message: 'Test notification sent' })),
    'DELETE /notifiers/:id': reasoned((r) => deleted('notifier', notifiers.remove(r.params.id))),
    'GET /secret-providers': () => f.secretProviders,
    'POST /secret-providers': reasoned((r) =>
      providers.create('sp', at(f.secretProviders, 0), {
        ...patchOf(r.body),
        kind: 'secret_provider',
      }),
    ),
    'PUT /secret-providers/:id': reasoned((r) =>
      orNotFound('secret provider', providers.patch(r.params.id, patchOf(r.body))),
    ),
    'POST /secret-providers/:id/enable': reasoned((r) =>
      orNotFound('secret provider', providers.patch(r.params.id, patchOf(r.body))),
    ),
    'POST /secret-providers/:id/reload': reasoned((r) =>
      orNotFound('secret provider', providers.get(r.params.id)),
    ),
    'DELETE /secret-providers/:id': reasoned((r) =>
      deleted('secret provider', providers.remove(r.params.id)),
    ),
    'GET /secret-providers/:id/secrets': (req) =>
      f.providerSecrets[req.params.id ?? ''] ?? notFound('Secret provider'),

    'GET /settings': () => f.settings,
    'PUT /settings': reasoned((r) => {
      f.settings = { ...f.settings, ...r.body?.settings };
      return f.settings;
    }),
    'GET /users': () => f.users,
    'GET /users/directory': () => f.users.map(({ id, email, role }) => ({ id, email, role })),
    'POST /users': reasoned((r) =>
      users.create('u', at(f.users, 1), {
        email: r.body?.email ?? '',
        role: r.body?.role ?? 'viewer',
      }),
    ),
    'PUT /users/:id': reasoned((r) =>
      orNotFound('User', users.patch(r.params.id, r.body ? { role: r.body.role } : {})),
    ),
    'DELETE /users/:id': reasoned((r) => deleted('User', users.remove(r.params.id))),
    'POST /users/:id/sessions/revoke': reasoned(() => mockStatus(204)),
    'PUT /users/:id/password': reasoned((r) =>
      orNotFound('User', users.patch(r.params.id, { hasPassword: true, mustChangePassword: true })),
    ),
    'DELETE /users/:id/password': reasoned((r) =>
      orNotFound(
        'User',
        users.patch(r.params.id, { hasPassword: false, mustChangePassword: false }),
      ),
    ),
    'GET /tokens': () => f.tokens,
    'POST /tokens': reasoned((r) => ({
      token: {
        ...at(f.tokens, 0),
        id: 'tok-new',
        name: r.body?.name ?? '',
        role: r.body?.role ?? 'viewer',
      },
      secret: 'sb_fixture-secret',
    })),
    'DELETE /tokens/:id': reasoned(() => mockStatus(204)),
    'GET /audit': () => page(f.audit),
    'GET /export': () => 'processes: []\n',
    'POST /apply': (r) => ({
      dryRun: Boolean(r.body?.dryRun),
      changes: [],
      errors: [],
    }),
    'GET /about': () => f.about,
  };
}

type AnyHandler = (req: Omit<MockRequest, 'body'> & { body: unknown }) => unknown;

interface CompiledRoute {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: AnyHandler;
  specificity: number;
}

function compile(key: string, handler: AnyHandler): CompiledRoute {
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

function compileAll(handlers: MockHandlers): CompiledRoute[] {
  return Object.entries(handlers).map(([k, h]) => compile(k, h as unknown as AnyHandler));
}

export function createMockApi(
  options: { fixtures?: Fixtures; overrides?: MockHandlers; delayMs?: number } = {},
): MockApi {
  const fixtures = options.fixtures ?? buildFixtures(Date.now());
  let handlers: MockHandlers = { ...defaultHandlers(fixtures), ...options.overrides };
  let routes = compileAll(handlers);
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
      routes = compileAll(handlers);
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
