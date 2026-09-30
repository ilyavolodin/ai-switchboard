// Mirrors the "AI Switchboard UI" design canvas. Times are relative to `now`, so a fixed `now`
// gives stable data in tests.
import { runStatusLabel } from '@ai-switchboard/core/domain';
import type {
  AboutResponse,
  ActivityRow,
  ApiTokenDTO,
  ApprovalHistoryItem,
  ApprovalItem,
  ApprovalRulesResponse,
  AuditEntry,
  BoardEdge,
  BoardResponse,
  CatalogueEntry,
  CronPreviewResponse,
  EventDetail,
  DestinationDetail,
  DestinationSummary,
  FilterPreviewResponse,
  FunnelResponse,
  GlobalSettings,
  InputPreviewResponse,
  InstanceSummary,
  LastDeliveryResponse,
  JSONSchema,
  MeResponse,
  MeterGaugeDTO,
  MeterHistoryResponse,
  PipelineDots,
  PluginSearchResult,
  PluginSummary,
  PluginTypeDTO,
  ProcessDetail,
  ProcessDocument,
  ProcessStatsResponse,
  ProcessSummary,
  ProcessVersionSummary,
  ProviderSecretsResponse,
  RecentBatchDTO,
  RunDetail,
  RunSummary,
  SourceDetail,
  SourceStatsResponse,
  SourceSummary,
  StatusLabel,
  StatusStripResponse,
  StatusTone,
  TraceResponse,
  UsageHistoryResponse,
  UserDTO,
} from '@ai-switchboard/core/contract';

import {
  inputSchema as routinesInputSchema,
  settingsSchema as routinesSettingsSchema,
  targetSchema as routinesTargetSchema,
} from '@ai-switchboard/destination-claude-routines/schemas';
import {
  inputSchema as actionsInputSchema,
  settingsSchema as actionsSettingsSchema,
  targetSchema as actionsTargetSchema,
} from '@ai-switchboard/destination-github-actions/schemas';
import {
  inputSchema as httpInputSchema,
  settingsSchema as httpSettingsSchema,
  targetSchema as httpTargetSchema,
} from '@ai-switchboard/destination-http/schemas';
import { settingsSchema as slackSettingsSchema } from '@ai-switchboard/notifier-slack/schemas';
import { settingsSchema as envSettingsSchema } from '@ai-switchboard/secrets-env/schemas';
import { settingsSchema as fileSettingsSchema } from '@ai-switchboard/secrets-file/schemas';
import { settingsSchema as datadogSettingsSchema } from '@ai-switchboard/source-datadog/schemas';
import { settingsSchema as githubSettingsSchema } from '@ai-switchboard/source-github/schemas';
import { settingsSchema as linearSettingsSchema } from '@ai-switchboard/source-linear/schemas';
import { settingsSchema as webhookSettingsSchema } from '@ai-switchboard/source-webhook/schemas';

import { at } from '../lib/at.js';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const IDS = {
  sources: {
    github: 'src-github',
    linear: 'src-linear',
    datadog: 'src-datadog',
    braintrust: 'src-braintrust',
    slack: 'src-slack',
  },
  destinations: { routines: 'dst-routines', actions: 'dst-actions', http: 'dst-http' },
  processes: {
    triage: 'p-triage',
    sizer: 'p-sizer',
    autofix: 'p-autofix',
    prReview: 'p-pr-review',
    merge: 'p-merge',
    ddMiner: 'p-dd-miner',
    sentiment: 'p-sentiment',
    flaky: 'p-flaky',
    depBumps: 'p-dep-bumps',
    scorecard: 'p-scorecard',
    nightly: 'p-nightly',
  },
} as const;

const S = IDS.sources;
const E = IDS.destinations;
const P = IDS.processes;

const st = (tone: StatusTone, label: string): StatusLabel => ({ tone, label });

function dots(
  counts: [number, number, number, number, number],
  tones: [StatusTone, StatusTone, StatusTone, StatusTone, StatusTone],
): PipelineDots {
  const [matched, batched, gated, invoked, ok] = counts;
  return { matched, batched, gated, invoked, ok, tones };
}

const OK5: [StatusTone, StatusTone, StatusTone, StatusTone, StatusTone] = [
  'ok',
  'ok',
  'ok',
  'ok',
  'ok',
];
const OFF5: [StatusTone, StatusTone, StatusTone, StatusTone, StatusTone] = [
  'off',
  'off',
  'off',
  'off',
  'off',
];

const SOURCE_SCHEMAS: Record<string, JSONSchema> = {
  linear: linearSettingsSchema,
  github: githubSettingsSchema,
  webhook: webhookSettingsSchema,
  datadog: datadogSettingsSchema,
};

type DestinationSchemas = Pick<
  DestinationDetail,
  'settingsSchema' | 'targetSchema' | 'inputSchema'
>;

const HTTP_SCHEMAS: DestinationSchemas = {
  settingsSchema: httpSettingsSchema,
  targetSchema: httpTargetSchema,
  inputSchema: httpInputSchema,
};

const DESTINATION_SCHEMAS: Record<string, DestinationSchemas> = {
  'claude-routines': {
    settingsSchema: routinesSettingsSchema,
    targetSchema: routinesTargetSchema,
    inputSchema: routinesInputSchema,
  },
  'github-actions': {
    settingsSchema: actionsSettingsSchema,
    targetSchema: actionsTargetSchema,
    inputSchema: actionsInputSchema,
  },
  http: HTTP_SCHEMAS,
};

/** `now` is epoch ms. */
export function buildFixtures(now: number) {
  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
  const nextAt = (hour: number): string => {
    const d = new Date(now);
    d.setHours(hour, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  };

  const user: UserDTO = {
    id: 'u-ilya',
    email: 'ilya@lola.com',
    role: 'operator',
    hasPassword: true,
    hasOidc: false,
    mustChangePassword: false,
    lastLoginAt: iso(-2 * HOUR),
    createdAt: iso(-90 * DAY),
  };
  const me: MeResponse = {
    user,
    authMode: 'local',
    oidcConfigured: false,
    oidcIssuer: null,
    evaluation: true,
    mustChangePassword: false,
    evaluationAdminEmail: 'admin@switchboard.local',
    requireReasons: true,
  };

  const fiveHour: MeterGaugeDTO = {
    destinationId: E.routines,
    destinationName: 'Claude Routines — automation seat',
    meterId: 'five_hour',
    title: '5-hour window',
    kind: 'window',
    unit: '%',
    utilization: 62,
    used: null,
    limit: null,
    resetsAt: iso(2 * HOUR + 10 * MIN),
    observedAt: iso(-2 * MIN),
    estimated: false,
    stale: false,
    ceilings: [
      { processId: P.autofix, processName: 'Autofix', events: 85, sweeps: 95 },
      { processId: P.triage, processName: 'Triage', events: 85, sweeps: 95 },
    ],
    ceilingState: 'below',
    primary: true,
  };
  const weekly: MeterGaugeDTO = {
    ...fiveHour,
    meterId: 'weekly',
    title: 'weekly window',
    utilization: 41,
    resetsAt: iso(3 * DAY + 4 * HOUR),
    observedAt: iso(-42 * MIN),
    stale: true,
    ceilings: [{ processId: P.autofix, processName: 'Autofix', events: 80, sweeps: 95 }],
    primary: false,
  };
  const dailyRuns: MeterGaugeDTO = {
    ...fiveHour,
    meterId: 'daily_runs',
    title: 'daily runs',
    kind: 'allowance',
    unit: 'runs',
    utilization: 63.6,
    used: 14,
    limit: 22,
    resetsAt: iso(5 * HOUR),
    estimated: true,
    ceilings: [{ processId: P.autofix, processName: 'Autofix', events: 72.7, sweeps: 90.9 }],
    primary: false,
  };
  const apiRate: MeterGaugeDTO = {
    destinationId: E.actions,
    destinationName: 'GitHub Actions — lola org',
    meterId: 'api_rate_limit',
    title: 'API rate limit',
    kind: 'window',
    unit: 'requests',
    utilization: 18,
    used: 900,
    limit: 5000,
    resetsAt: iso(38 * MIN),
    observedAt: iso(-1 * MIN),
    estimated: false,
    stale: false,
    ceilings: [],
    ceilingState: 'below',
    primary: true,
  };
  const routinesMeters = [fiveHour, weekly, dailyRuns];
  const actionsMeters = [apiRate];

  const status: StatusStripResponse = {
    meters: [...routinesMeters, ...actionsMeters],
    openBreakers: 1,
    pendingApprovals: 2,
    evaluation: true,
    oidcConfigured: false,
  };

  const health = (s: 'healthy' | 'unhealthy' | 'unknown', message?: string) => ({
    status: s,
    checkedAt: iso(-1 * MIN),
    ...(message ? { message } : {}),
  });

  const hours = Array.from({ length: 24 }, (_, i) => iso(-(23 - i) * HOUR));
  const shape = [
    20, 12, 8, 6, 6, 10, 30, 55, 70, 85, 100, 80, 65, 75, 90, 70, 60, 40, 25, 15, 10, 8, 12, 45,
  ];
  const eventsByHour = (total: number, throttledShare = 0) => {
    const whole = shape.reduce((a, b) => a + b, 0);
    return hours.map((hour, i) => {
      const count = Math.round((total * (shape[i] ?? 0)) / whole);
      return { hour, count, throttled: Math.round(count * throttledShare) };
    });
  };

  const sources: SourceSummary[] = [
    {
      id: S.github,
      name: 'GitHub — acme org',
      typeId: 'github',
      typeName: 'GitHub',
      typeIcon: 'pr',
      mode: 'push',
      enabled: true,
      status: st('error', 'auth failure'),
      health: health('unhealthy', 'token refresh failed 50 min ago'),
      lastEventAt: iso(-3 * MIN),
      eventsByType24h: [
        { type: 'pull_request.opened', count: 38 },
        { type: 'check_suite.completed', count: 72 },
        { type: 'pull_request_review.submitted', count: 31 },
      ],
      eventsByHour24h: eventsByHour(141),
      pluginAvailable: true,
      unauthenticated: false,
      processCount: 4,
    },
    {
      id: S.linear,
      name: 'Linear — lola',
      typeId: 'linear',
      typeName: 'Linear',
      typeIcon: 'issue',
      mode: 'push',
      enabled: true,
      status: st('ok', 'healthy'),
      health: health('healthy'),
      lastEventAt: iso(-4 * MIN),
      eventsByType24h: [
        { type: 'issue.label_added', count: 168 },
        { type: 'issue.state_changed', count: 96 },
        { type: 'comment.created', count: 48 },
      ],
      eventsByHour24h: eventsByHour(312),
      pluginAvailable: true,
      unauthenticated: false,
      processCount: 3,
    },
    {
      id: S.datadog,
      name: 'Datadog — prod',
      typeId: 'datadog',
      typeName: 'Datadog',
      typeIcon: 'alert',
      mode: 'pull',
      enabled: true,
      status: st('ok', 'healthy'),
      health: health('healthy'),
      lastEventAt: iso(-2 * MIN),
      eventsByType24h: [
        { type: 'error.issue_new', count: 19 },
        { type: 'monitor.alert', count: 8 },
      ],
      eventsByHour24h: eventsByHour(27),
      pluginAvailable: true,
      unauthenticated: false,
      processCount: 2,
    },
    {
      id: S.braintrust,
      name: 'Braintrust — webhook',
      typeId: 'braintrust',
      typeName: 'Braintrust',
      typeIcon: null,
      mode: 'pull',
      enabled: true,
      status: st('warn', 'silent 26 h'),
      health: health('healthy'),
      lastEventAt: iso(-26 * HOUR),
      eventsByType24h: [],
      eventsByHour24h: eventsByHour(0),
      pluginAvailable: false,
      unauthenticated: false,
      processCount: 1,
    },
    {
      id: S.slack,
      name: 'Slack — Events API',
      typeId: 'webhook',
      typeName: 'Webhook',
      typeIcon: 'webhook',
      mode: 'push',
      enabled: false,
      status: st('off', 'disabled'),
      health: null,
      lastEventAt: iso(-18 * DAY),
      eventsByType24h: [],
      eventsByHour24h: eventsByHour(0),
      pluginAvailable: true,
      unauthenticated: true,
      processCount: 0,
    },
  ];

  const sourceDetail = (s: SourceSummary): SourceDetail => ({
    ...s,
    settings:
      s.typeId === 'linear'
        ? {
            apiKey: 'secret://env/LINEAR_API_KEY',
            webhookSecret: 'secret://env/LINEAR_WEBHOOK_SECRET',
            teamKeys: ['LOL'],
          }
        : {},
    caps: { eventCapPerHour: 600, eventCapPerDay: 5000 },
    webhookUrl: s.mode === 'pull' ? null : `https://switchboard.lola.com/hooks/${s.id}`,
    pollIntervalSeconds: s.mode === 'pull' ? 300 : null,
    provisionSupported: s.typeId === 'linear' || s.typeId === 'github',
    provisionedAt: s.typeId === 'linear' ? iso(-30 * DAY) : null,
    secretRefs:
      s.typeId === 'linear'
        ? [
            {
              field: 'apiKey',
              ref: 'secret://env/LINEAR_API_KEY',
              lastResolvedAt: iso(-13 * HOUR),
              ok: true,
            },
            {
              field: 'webhookSecret',
              ref: 'secret://env/LINEAR_WEBHOOK_SECRET',
              lastResolvedAt: iso(-13 * HOUR),
              ok: true,
            },
          ]
        : [],
    eventTypes:
      s.typeId === 'linear'
        ? [
            {
              type: 'issue.label_added',
              title: 'Issue labelled',
              description: 'A label was added to an issue.',
              attributes: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'the label added, e.g. "autofix"' },
                  team: { type: 'string', description: 'team key' },
                  actor: { type: 'string', description: 'who made the change' },
                },
              },
              examples: [{ label: 'autofix', team: 'LOL', actor: 'daria' }],
            },
            {
              type: 'issue.state_changed',
              title: 'Issue state changed',
              description: 'An issue moved between workflow states.',
              attributes: {
                type: 'object',
                properties: { state: { type: 'string' }, team: { type: 'string' } },
              },
              examples: [{ state: 'Todo', team: 'LOL' }],
            },
          ]
        : [],
    actions:
      s.typeId === 'linear'
        ? [
            {
              id: 'addLabel',
              title: 'Add label',
              argsSchema: { type: 'object', properties: { label: { type: 'string' } } },
              describe: 'Add label {{label}}',
            },
            {
              id: 'comment',
              title: 'Comment',
              argsSchema: { type: 'object', properties: { body: { type: 'string' } } },
            },
          ]
        : [],
    settingsSchema: SOURCE_SCHEMAS[s.typeId] ?? { type: 'object', properties: {} },
    lastVerifyFailureAt: s.id === S.github ? iso(-50 * MIN) : null,
    instanceError:
      s.id === S.github ? 'installation token refresh failed: 401 Bad credentials' : null,
    processes: [],
    createdAt: iso(-120 * DAY),
    updatedAt: iso(-3 * DAY),
  });

  const destinations: DestinationSummary[] = [
    {
      id: E.routines,
      name: 'Claude Routines — automation seat',
      typeId: 'claude-routines',
      typeName: 'Claude Routines',
      typeIcon: 'run',
      enabled: true,
      status: st('ok', 'healthy'),
      health: health('healthy'),
      meters: routinesMeters,
      softHoldUntil: null,
      softHoldReason: null,
      pluginAvailable: true,
      runs24h: 12,
      processCount: 7,
    },
    {
      id: E.actions,
      name: 'GitHub Actions — lola org',
      typeId: 'github-actions',
      typeName: 'GitHub Actions',
      typeIcon: 'play',
      enabled: true,
      status: st('error', 'unhealthy'),
      health: health('unhealthy', 'installation token failed 07:12'),
      meters: actionsMeters,
      softHoldUntil: null,
      softHoldReason: null,
      pluginAvailable: true,
      runs24h: 4,
      processCount: 3,
    },
    {
      id: E.http,
      name: 'HTTP — internal jobs',
      typeId: 'http',
      typeName: 'HTTP',
      typeIcon: 'link',
      enabled: true,
      status: st('ok', 'healthy'),
      health: health('healthy'),
      meters: [],
      softHoldUntil: null,
      softHoldReason: null,
      pluginAvailable: true,
      runs24h: 1,
      processCount: 1,
    },
  ];

  const destinationDetail = (x: DestinationSummary): DestinationDetail => ({
    ...x,
    settings:
      x.typeId === 'claude-routines'
        ? {
            token: 'secret://env/CLAUDE_API_KEY',
            callbackSecret: 'secret://env/ROUTINE_CALLBACK_SECRET',
          }
        : {},
    targetDefaults: {},
    caps: { runsPerHour: 6, runsPerDay: 22, meterPollSeconds: 60, meterStalenessMinutes: 15 },
    ...(DESTINATION_SCHEMAS[x.typeId] ?? HTTP_SCHEMAS),
    tracking: x.typeId === 'claude-routines' ? 'callback' : x.typeId === 'http' ? 'sync' : 'poll',
    idempotentInvoke: x.typeId !== 'claude-routines',
    usage: [
      {
        id: 'input_tokens',
        title: 'Input tokens',
        unit: 'tokens',
        aggregate: 'sum',
        budgetable: true,
      },
      {
        id: 'output_tokens',
        title: 'Output tokens',
        unit: 'tokens',
        aggregate: 'sum',
        budgetable: true,
      },
      {
        id: 'duration_seconds',
        title: 'Duration',
        unit: 'seconds',
        aggregate: 'sum',
        budgetable: true,
      },
    ],
    meterSpecs: x.meters.map((m) => ({
      id: m.meterId,
      title: m.title,
      kind: m.kind,
      unit: m.unit,
      ...(m.primary ? { primary: true } : {}),
    })),
    actions: [],
    callbackUrl: `https://switchboard.lola.com/callbacks/${x.id}`,
    secretRefs: [],
    instanceError: x.id === E.actions ? 'installation token failed: 401' : null,
    processes: [],
    createdAt: iso(-120 * DAY),
    updatedAt: iso(-5 * DAY),
  });

  const exRef = (id: string) => {
    const x = destinations.find((e) => e.id === id);
    return x ? { id: x.id, name: x.name } : null;
  };
  const trig = (sourceId: string, describe: string, eventTypes: string[]) => ({
    sourceId,
    sourceName: sources.find((s) => s.id === sourceId)?.name ?? sourceId,
    describe,
    eventTypes,
  });
  const summary = (
    p: Omit<ProcessSummary, 'updatedAt' | 'description' | 'breakerState' | 'awaitingApproval'> &
      Partial<Pick<ProcessSummary, 'description' | 'breakerState' | 'awaitingApproval'>>,
  ): ProcessSummary => ({
    description: '',
    breakerState: 'closed',
    awaitingApproval: 0,
    updatedAt: iso(-2 * DAY),
    ...p,
  });

  const processes: ProcessSummary[] = [
    summary({
      id: P.triage,
      name: 'Triage',
      description: 'Labels and routes new Linear bugs and Datadog errors.',
      enabled: true,
      status: st('ok', 'healthy'),
      dots: dots([14, 6, 6, 6, 6], OK5),
      sparkline: [5, 7, 6, 9, 8, 10, 9],
      nextSweepAt: nextAt(10),
      dailyCap: { used: 6, limit: 8 },
      lastRunAt: iso(-12 * MIN),
      destination: exRef(E.routines),
      triggers: [
        trig(S.linear, 'Linear issue created in LOL', ['issue.created', 'issue.label_added']),
        trig(S.datadog, 'New Datadog error issue in prod', ['error.issue_new']),
      ],
    }),
    summary({
      id: P.sizer,
      name: 'Sizer',
      enabled: true,
      status: st('ok', 'healthy'),
      dots: dots([9, 3, 3, 3, 3], OK5),
      sparkline: [8, 6, 10, 9, 12, 11, 12],
      nextSweepAt: iso(40 * MIN),
      dailyCap: { used: 3, limit: 6 },
      lastRunAt: iso(-25 * MIN),
      destination: exRef(E.routines),
      triggers: [trig(S.linear, 'Issue moved to Triage', ['issue.state_changed'])],
    }),
    summary({
      id: P.autofix,
      name: 'Autofix',
      description:
        'Opens a fix PR for small bugs labelled autofix in Linear. Never touches prompts.',
      enabled: true,
      status: st('error', 'breaker open'),
      breakerState: 'open',
      dots: dots([4, 2, 2, 2, 0], ['ok', 'ok', 'ok', 'ok', 'error']),
      sparkline: [3, 4, 2, 4, 3, 4, 3],
      nextSweepAt: nextAt(7),
      dailyCap: { used: 3, limit: 4 },
      lastRunAt: iso(-18 * MIN),
      destination: exRef(E.routines),
      triggers: [
        trig(S.linear, "Linear issue labelled autofix where it's complexity:simple", [
          'issue.label_added',
          'issue.state_changed',
        ]),
      ],
    }),
    summary({
      id: P.prReview,
      name: 'PR Review',
      enabled: true,
      status: st('ok', 'healthy'),
      dots: dots([11, 4, 4, 4, 4], OK5),
      sparkline: [6, 9, 7, 10, 12, 8, 4],
      nextSweepAt: null,
      dailyCap: { used: 4, limit: null },
      lastRunAt: iso(-15 * MIN),
      destination: exRef(E.actions),
      triggers: [trig(S.github, 'Pull request opened in acme/app', ['pull_request.opened'])],
    }),
    summary({
      id: P.merge,
      name: 'Merge',
      enabled: true,
      status: st('warn', 'awaiting approval'),
      awaitingApproval: 2,
      dots: dots([3, 3, 2, 0, 0], ['ok', 'ok', 'warn', 'off', 'off']),
      sparkline: [1, 2, 1, 3, 2, 1, 1],
      nextSweepAt: iso(22 * MIN),
      dailyCap: { used: 1, limit: 3 },
      lastRunAt: iso(-5 * HOUR),
      destination: exRef(E.http),
      triggers: [
        trig(S.github, 'Checks green on a PR with 2 approvals', ['check_suite.completed']),
      ],
    }),
    summary({
      id: P.ddMiner,
      name: 'Datadog Miner',
      enabled: true,
      status: st('ok', 'healthy'),
      dots: dots([2, 1, 1, 1, 1], OK5),
      sparkline: [1, 2, 1, 1, 2, 1, 1],
      nextSweepAt: nextAt(7),
      dailyCap: { used: 1, limit: 2 },
      lastRunAt: iso(-1 * HOUR),
      destination: exRef(E.routines),
      triggers: [trig(S.datadog, 'New error issue in checkout', ['error.issue_new'])],
    }),
    summary({
      id: P.sentiment,
      name: 'Sentiment',
      enabled: true,
      status: st('warn', 'held · plugin unavailable'),
      dots: dots([0, 0, 0, 0, 0], OFF5),
      sparkline: [0, 1, 0, 0, 1, 0, 0],
      nextSweepAt: iso(2 * DAY),
      dailyCap: { used: 0, limit: 1 },
      lastRunAt: iso(-6 * DAY),
      destination: exRef(E.routines),
      triggers: [trig(S.braintrust, 'Session scored below 0.4', ['session.low_score'])],
    }),
    summary({
      id: P.flaky,
      name: 'Flaky Tests',
      enabled: true,
      status: st('warn', 'throttled'),
      dots: dots([5, 2, 2, 0, 0], ['ok', 'ok', 'warn', 'off', 'off']),
      sparkline: [2, 2, 2, 1, 2, 2, 2],
      nextSweepAt: nextAt(12),
      dailyCap: { used: 2, limit: 2 },
      lastRunAt: iso(-3 * HOUR),
      destination: exRef(E.actions),
      triggers: [trig(S.github, 'A check failed twice on main', ['check_suite.completed'])],
    }),
    summary({
      id: P.depBumps,
      name: 'Dep Bumps',
      enabled: false,
      status: st('off', 'disabled'),
      dots: dots([0, 0, 0, 0, 0], OFF5),
      sparkline: [0, 0, 0, 0, 0, 0, 0],
      nextSweepAt: null,
      dailyCap: { used: 0, limit: 2 },
      lastRunAt: iso(-18 * DAY),
      destination: exRef(E.actions),
      triggers: [trig(S.github, 'Dependabot PR opened', ['pull_request.opened'])],
    }),
    summary({
      id: P.scorecard,
      name: 'Scorecard',
      enabled: true,
      status: st('off', 'not yet run'),
      dots: dots([0, 0, 0, 0, 0], OFF5),
      sparkline: [0, 0, 0, 0, 0, 0, 0],
      nextSweepAt: iso(4 * DAY),
      dailyCap: { used: 0, limit: 1 },
      lastRunAt: null,
      destination: exRef(E.routines),
      triggers: [],
    }),
    summary({
      id: P.nightly,
      name: 'Nightly sweep',
      description: 'Sweeps stale autofix candidates every night.',
      enabled: true,
      status: st('ok', 'healthy'),
      dots: dots([0, 0, 1, 1, 1], ['off', 'off', 'ok', 'ok', 'ok']),
      sparkline: [1, 1, 1, 1, 1, 1, 1],
      nextSweepAt: nextAt(2),
      dailyCap: { used: 1, limit: 1 },
      lastRunAt: iso(-20 * HOUR),
      destination: exRef(E.routines),
      triggers: [],
    }),
  ];

  const autofixDocument: ProcessDocument = {
    name: 'Autofix',
    description: 'Opens a fix PR for small bugs labelled autofix in Linear. Never touches prompts.',
    enabled: true,
    triggers: [
      {
        id: 't1',
        sourceId: S.linear,
        eventTypes: ['issue.label_added', 'issue.state_changed'],
        filter: "attributes.label = 'autofix' and 'complexity:simple' in $resolve(artifact).labels",
        describe: "Linear issue labelled autofix where it's complexity:simple",
        enabled: true,
      },
      {
        id: 't2',
        sourceId: S.datadog,
        eventTypes: ['error.issue_tagged'],
        describe: 'Datadog error tagged autofix',
        enabled: false,
      },
    ],
    schedules: [
      { id: 's1', cron: '0 7 * * *', timezone: 'America/New_York', catchUp: 'once', enabled: true },
    ],
    batching: { debounceSeconds: 90, maxSize: 3, maxAgeSeconds: 600, groupBy: 'artifact.id' },
    gates: {
      quietHours: { start: '22:00', end: '07:00', timezone: 'America/New_York' },
      approval: 'none',
      breaker: { threshold: 3, cooldownMinutes: 60 },
    },
    budgets: {
      runsPerHour: 2,
      runsPerDay: 4,
      usagePerDay: { input_tokens: 400_000 },
      meterCeilings: {
        five_hour: { events: 85, sweeps: 95 },
        weekly: { events: 80, sweeps: 95 },
      },
    },
    destination: {
      instanceId: E.routines,
      target: { routineId: 'autofix-v3', token: 'secret://env/LOOPS_ROUTINE_TOKEN_AUTOFIX' },
    },
    input:
      '{\n  "text": "run " & run.id & " · mode " & mode\n    & $join(events.("· fix " & artifact.id & " (" & artifact.url & ") · " & attributes.label), " ")\n}',
    before: [{ provider: S.linear, action: 'addLabel', args: '{ "label": "lp:autofix-running" }' }],
    after: [
      {
        provider: S.linear,
        action: 'comment',
        args: '{ "body": "Autofix opened " & result.pr }',
        when: 'result.ok',
      },
    ],
    notify: [
      {
        notifierId: 'n-slack',
        template: '"Autofix " & run.status',
        on: ['error', 'held', 'throttled'],
      },
    ],
    trackingDeadlineMinutes: 120,
  };

  const run = (
    id: string,
    status: RunSummary['status'],
    tone: StatusTone,
    label: string,
    ago: number,
    extra: Partial<RunSummary> = {},
  ): RunSummary => ({
    id,
    processId: P.autofix,
    processName: 'Autofix',
    destinationId: E.routines,
    destinationName: 'Claude Routines — automation seat',
    kind: 'event',
    status,
    statusLabel: st(tone, label),
    statusReason: null,
    externalId: `session_${id.slice(-4)}`,
    externalUrl: `https://claude.ai/code/session_${id.slice(-4)}`,
    usage: { input_tokens: 48_200, output_tokens: 6_100, duration_seconds: 398 },
    dryRun: false,
    invokedAt: iso(-ago),
    finishedAt: iso(-ago + 6 * MIN + 38_000),
    durationSeconds: 398,
    eventCount: 1,
    artifacts: [
      { kind: 'linear.issue', id: 'LOL-1712', url: 'https://linear.app/lola/issue/LOL-1712' },
    ],
    ...extra,
  });

  const recentFailures: RunSummary[] = [
    run('run_01J8KQ4A1', 'error', 'error', 'run error', 60 * MIN, {
      statusReason: 'could not check out branch',
    }),
    run('run_01J8KQ4B2', 'error', 'error', 'run error', 54 * MIN, {
      statusReason: 'rate limited by GitHub',
    }),
    run('run_01J8KQ4C3', 'error', 'error', 'run error', 14 * MIN, {
      statusReason: 'test suite timed out (vitest, packages/engine)',
    }),
  ];

  const runs: RunSummary[] = [
    ...recentFailures,
    run('run_01J8KP9Z0', 'ok', 'ok', 'run ok', 5 * HOUR, { kind: 'sweep' }),
    run('run_01J8KN2Y9', 'ok', 'ok', 'run ok', 26 * HOUR),
    run('run_01J8KM1X8', 'running', 'off', 'running', 2 * MIN, {
      finishedAt: null,
      durationSeconds: null,
    }),
  ];

  const processDetail = (p: ProcessSummary): ProcessDetail => ({
    id: p.id,
    name: p.name,
    document:
      p.id === P.autofix
        ? autofixDocument
        : {
            ...autofixDocument,
            name: p.name,
            description: p.description,
            enabled: p.enabled,
            triggers: [],
            destination: { instanceId: p.destination?.id ?? E.routines, target: {} },
          },
    enabled: p.enabled,
    status: p.status,
    breakerState: p.breakerState,
    breakerOpenedAt: p.breakerState === 'open' ? iso(-14 * MIN) : null,
    recentFailures: p.breakerState === 'open' ? recentFailures : [],
    version: 12,
    nextSweepAt: p.nextSweepAt,
    awaitingApproval: p.awaitingApproval,
    createdAt: iso(-60 * DAY),
    updatedAt: iso(-1 * DAY),
  });

  const runDetail: RunDetail = {
    ...at(recentFailures, 2),
    batchId: 'b-autofix-0736',
    requestedBy: null,
    input: { text: 'run 01J8KQ4…Q4 · mode event · fix LOL-1712 · complexity:simple' },
    result: null,
    errors: ['test suite timed out (vitest, packages/engine)'],
    steps: [
      {
        phase: 'before',
        index: 0,
        providerId: S.linear,
        action: 'addLabel',
        args: { label: 'lp:autofix-running' },
        status: 'ok',
        error: null,
        at: iso(-14 * MIN),
      },
      {
        phase: 'after',
        index: 0,
        providerId: S.linear,
        action: 'comment',
        args: { body: 'Autofix failed: test suite timed out' },
        status: 'uncertain',
        error: 'in doubt after an interrupted attempt; not repeated (the action is not idempotent)',
        at: iso(-8 * MIN),
      },
    ],
    updates: [
      { at: iso(-14 * MIN), source: 'invoke', status: 'running', detail: null },
      { at: iso(-8 * MIN), source: 'callback', status: 'error', detail: { reason: 'timeout' } },
    ],
  };

  const funnel: FunnelResponse = {
    window: '7d',
    event: {
      received: 212,
      matched: 184,
      // Dropped as duplicates: 131 remain after dedupe.
      deduped: 53,
      batched: 62,
      batches: 62,
      held: 9,
      throttled: 4,
      invoked: 49,
      ok: 44,
      error: 3,
      failed: 0,
      unknown: 2,
      running: 0,
    },
    sweep: { fired: 7, held: 0, throttled: 0, invoked: 7, ok: 7, error: 0 },
  };

  const days = Array.from({ length: 7 }, (_, i) => iso(-(6 - i) * DAY));
  const processStats: ProcessStatsResponse = {
    window: '7d',
    days: days.map((day, i) => ({
      day,
      runs: { ok: [6, 9, 7, 8, 5, 4, 9][i] ?? 0, error: i === 6 ? 3 : 0 },
      throttled: [0, 1, 0, 2, 0, 0, 1][i] ?? 0,
      held: 0,
      latencyP50Seconds: 2,
      durationP50Seconds: [290, 260, 340, 330, 280, 300, 564][i] ?? 300,
    })),
    usagePerRun: [
      {
        dimension: 'input_tokens',
        title: 'Input tokens',
        unit: 'tokens',
        average: 48_200,
        total: 2_361_800,
      },
      {
        dimension: 'duration_seconds',
        title: 'Duration',
        unit: 'seconds',
        average: 398,
        total: 19_502,
      },
    ],
  };

  const versions: ProcessVersionSummary[] = [
    {
      version: 12,
      savedBy: 'ilya@lola.com',
      savedAt: iso(-1 * DAY),
      reason: 'lower runs per hour to 2',
    },
    { version: 11, savedBy: 'daria@lola.com', savedAt: iso(-4 * DAY), reason: 'add quiet hours' },
    {
      version: 10,
      savedBy: 'ilya@lola.com',
      savedAt: iso(-9 * DAY),
      reason: 'initial import from YAML',
    },
  ];

  // 12 is current, 11 had 4 runs/h, 10 no quiet hours.
  const versionDocument = (version: number): ProcessDocument => {
    if (version >= 12) return autofixDocument;
    const v11: ProcessDocument = {
      ...autofixDocument,
      budgets: { ...autofixDocument.budgets, runsPerHour: 4 },
    };
    if (version === 11) return v11;
    const { quietHours: _none, ...gates } = v11.gates;
    return { ...v11, gates };
  };

  const batches: RecentBatchDTO[] = [
    {
      id: 'b-autofix-0736',
      kind: 'event',
      openedAt: iso(-22 * MIN),
      size: 2,
      outcome: 'invoked',
      artifacts: [
        { kind: 'linear.issue', id: 'LOL-1712', url: 'https://linear.app/lola/issue/LOL-1712' },
      ],
    },
    {
      id: 'b-autofix-sweep',
      kind: 'sweep',
      openedAt: iso(-5 * HOUR),
      size: 0,
      outcome: 'invoked',
      artifacts: [],
    },
  ];

  const art = (kind: string, id: string) => ({
    kind,
    id,
    url:
      kind === 'linear.issue'
        ? `https://linear.app/lola/issue/${id}`
        : kind === 'github.pr'
          ? `https://github.com/acme/app/pull/${id}`
          : `https://app.datadoghq.com/error-tracking/${id}`,
  });
  const row = (
    eventId: string,
    sourceId: string,
    type: string,
    artifact: ReturnType<typeof art>,
    ago: number,
    reached: 0 | 1 | 2 | 3 | 4 | 5,
    tone: StatusTone,
    label: string,
    procs: Omit<ActivityRow['processes'][number], 'statusLabel'>[],
  ): ActivityRow => ({
    eventId,
    sourceId,
    sourceName: sources.find((s) => s.id === sourceId)?.name ?? sourceId,
    type,
    occurredAt: iso(-ago - 2000),
    receivedAt: iso(-ago),
    artifact,
    stage: reached === 1 ? 'unmatched' : 'matched',
    indicator: { reached, tone, label },
    processes: procs.map((p) => ({
      ...p,
      statusLabel: p.runStatus ? runStatusLabel(p.runStatus) : null,
    })),
    replayOf: null,
    whyNothingRan: null,
  });

  const activity: ActivityRow[] = [
    row(
      'ev-1720',
      S.linear,
      'issue.label_added',
      art('linear.issue', 'LOL-1720'),
      2 * MIN,
      5,
      'ok',
      'run ok',
      [{ id: P.triage, name: 'Triage', outcome: 'invoked', runId: 'run_01J8KR1', runStatus: 'ok' }],
    ),
    row(
      'ev-481',
      S.github,
      'pull_request.opened',
      art('github.pr', '481'),
      5 * MIN,
      4,
      'off',
      'running',
      [
        {
          id: P.prReview,
          name: 'PR Review',
          outcome: 'invoked',
          runId: 'run_01J8KR2',
          runStatus: 'running',
        },
      ],
    ),
    row(
      'ev-1712b',
      S.linear,
      'issue.state_changed',
      art('linear.issue', 'LOL-1712'),
      23 * MIN,
      5,
      'error',
      'run error',
      [
        {
          id: P.autofix,
          name: 'Autofix',
          outcome: 'invoked',
          runId: 'run_01J8KQ4C3',
          runStatus: 'error',
        },
      ],
    ),
    row(
      'ev-1712a',
      S.linear,
      'issue.label_added',
      art('linear.issue', 'LOL-1712'),
      24 * MIN,
      5,
      'error',
      'run error',
      [
        {
          id: P.autofix,
          name: 'Autofix',
          outcome: 'invoked',
          runId: 'run_01J8KQ4C3',
          runStatus: 'error',
        },
      ],
    ),
    row(
      'ev-480',
      S.github,
      'check_suite.completed',
      art('github.pr', '480'),
      30 * MIN,
      3,
      'warn',
      'held · awaiting approval',
      [{ id: P.merge, name: 'Merge', outcome: 'awaiting_approval', runId: null, runStatus: null }],
    ),
    row(
      'ev-479',
      S.github,
      'check_suite.completed',
      art('github.pr', '479'),
      38 * MIN,
      3,
      'warn',
      'throttled · day cap 2/2',
      [{ id: P.flaky, name: 'Flaky Tests', outcome: 'throttled', runId: null, runStatus: null }],
    ),
    {
      ...row(
        'ev-1709',
        S.linear,
        'comment.created',
        art('linear.issue', 'LOL-1709'),
        38 * MIN,
        1,
        'off',
        'no process matched',
        [],
      ),
      whyNothingRan:
        'Autofix: event type comment.created is not in trigger "autofix label" (subscribes to issue.label_added)',
    },
    row(
      'ev-dd9f21',
      S.datadog,
      'error.issue_new',
      art('datadog.issue', 'err-9f21'),
      60 * MIN,
      5,
      'ok',
      'run ok',
      [
        {
          id: P.ddMiner,
          name: 'Datadog Miner',
          outcome: 'invoked',
          runId: 'run_01J8KP1',
          runStatus: 'ok',
        },
      ],
    ),
  ];

  const eventDetail: EventDetail = {
    ...at(activity, 3),
    attributes: {
      label: 'autofix',
      team: 'LOL',
      actor: 'daria',
      labels: ['autofix', 'complexity:simple', 'bug'],
    },
    dedupeKey: 'issue.label_added:linear.issue:LOL-1712:2026-09-27T07:36:41Z',
    deliveryId: 'lin_dlv_8f2c',
    stageReason: null,
    explanations: [
      {
        processId: P.autofix,
        processName: 'Autofix',
        taken: true,
        reason: 'trigger "autofix label" matched',
        basis: 'recorded',
        tone: 'ok',
      },
    ],
    raw: {
      headers: { 'content-type': 'application/json', 'linear-signature': '[verified]' },
      body: '{"action":"update","type":"Issue","data":{"identifier":"LOL-1712"}}',
      truncated: false,
    },
  };

  const trace: TraceResponse = {
    query: 'LOL-1712',
    artifacts: [
      { kind: 'linear.issue', id: 'LOL-1712', url: 'https://linear.app/lola/issue/LOL-1712' },
    ],
    entries: [
      {
        at: iso(-24 * MIN),
        kind: 'event',
        tone: 'off',
        title: 'Event joined',
        detail: 'Linear · issue.label_added · autofix by daria',
        eventId: 'ev-1712a',
        data: { verified: true, trigger: 't1' },
      },
      {
        at: iso(-24 * MIN + 1000),
        kind: 'filter',
        tone: 'ok',
        title: 'Filter matched',
        detail: 'Autofix · trigger 1',
        processId: P.autofix,
        processName: 'Autofix',
        data: {
          expression:
            "attributes.label = 'autofix' and 'complexity:simple' in $resolve(artifact).labels",
          result: true,
        },
      },
      {
        at: iso(-24 * MIN + 2000),
        kind: 'batch_open',
        tone: 'ok',
        title: 'Batch opened',
        detail: 'debounce 90 s · max 3',
        processId: P.autofix,
        processName: 'Autofix',
        batchId: 'b-autofix-0736',
      },
      {
        at: iso(-23 * MIN),
        kind: 'batch_join',
        tone: 'ok',
        title: 'Merged into the open batch',
        detail: 'issue.state_changed · 1 duplicate dropped',
        eventId: 'ev-1712b',
        batchId: 'b-autofix-0736',
      },
      {
        at: iso(-22 * MIN),
        kind: 'gate',
        tone: 'ok',
        title: 'Gate checks passed',
        detail: 'enabled · breaker closed · quiet hours off · approval none',
        processId: P.autofix,
        processName: 'Autofix',
        data: {
          enabled: 'pass',
          breaker: 'closed · pass',
          quietHours: 'off · pass',
          approval: 'none · pass',
        },
      },
      {
        at: iso(-22 * MIN + 500),
        kind: 'budget',
        tone: 'ok',
        title: 'Budget ok',
        detail: 'process day cap 3 / 4',
        data: {
          binding: 'process day cap',
          runsToday: 3,
          runsPerDay: 4,
          'meter five_hour': '62% (ceiling 85%)',
        },
      },
      {
        at: iso(-22 * MIN + 900),
        kind: 'invoke',
        tone: 'ok',
        title: 'Invoked',
        detail: 'Claude Routines — automation seat · routine autofix-v3',
        runId: 'run_01J8KQ4C3',
        externalUrl: 'https://claude.ai/code/session_4C3',
      },
      {
        at: iso(-22 * MIN + 1500),
        kind: 'step',
        tone: 'ok',
        title: 'Step before: Add label',
        detail: 'lp:autofix-running',
      },
      {
        at: iso(-15 * MIN),
        kind: 'terminal',
        tone: 'error',
        title: 'Run error after 6 m 38 s',
        detail: 'test suite timed out (vitest, packages/engine) · breaker 3 / 3 → open',
        runId: 'run_01J8KQ4C3',
        data: { input_tokens: 48_200, duration_seconds: 398 },
      },
    ],
    text: 'LOL-1712\n07:36:41 Event joined · Linear · issue.label_added\n07:44:50 Run error after 6 m 38 s',
  };

  const approvals: ApprovalItem[] = [
    {
      batchId: 'b-merge-480',
      process: { id: P.merge, name: 'Merge' },
      rule: 'always',
      requestedAt: iso(-32 * MIN),
      artifacts: [{ kind: 'github.pr', id: '480', url: 'https://github.com/acme/app/pull/480' }],
      eventCount: 1,
      kind: 'event',
      input: {
        mode: 'event',
        refs: ['https://github.com/acme/app/pull/480'],
        checks: 'green · 2 approvals',
      },
    },
    {
      batchId: 'b-merge-483',
      process: { id: P.merge, name: 'Merge' },
      rule: 'always',
      requestedAt: iso(-6 * MIN),
      artifacts: [
        { kind: 'github.pr', id: '483', url: 'https://github.com/acme/app/pull/483' },
        { kind: 'github.pr', id: '484', url: 'https://github.com/acme/app/pull/484' },
      ],
      eventCount: 2,
      kind: 'event',
      input: { mode: 'event', refs: ['#483', '#484'], checks: 'green · 1 approval each' },
    },
  ];
  const approvalHistory: ApprovalHistoryItem[] = [
    {
      ...(approvals[0] ?? ({} as ApprovalItem)),
      batchId: 'b-merge-479',
      artifacts: [{ kind: 'github.pr', id: '479', url: 'https://github.com/acme/app/pull/479' }],
      decision: 'approved',
      decidedBy: 'daria@lola.com',
      decidedAt: iso(-1 * DAY),
      reason: 'green, small',
    },
    {
      ...(approvals[0] ?? ({} as ApprovalItem)),
      batchId: 'b-merge-471',
      artifacts: [{ kind: 'github.pr', id: '471', url: 'https://github.com/acme/app/pull/471' }],
      decision: 'rejected',
      decidedBy: 'priya@lola.com',
      decidedAt: iso(-2 * DAY),
      reason: 'touches billing; wait for the gate change',
    },
  ];
  const approvalRules: ApprovalRulesResponse = {
    processes: [
      { id: P.merge, name: 'Merge', rule: 'always' },
      { id: P.depBumps, name: 'Dep Bumps', rule: 'attributes.files > 20' },
    ],
  };

  const edge = (
    kind: BoardEdge['kind'],
    from: string,
    to: string,
    volume24h: number,
    recent: number,
    eventTypes: string[] = [],
    enabled = true,
  ): BoardEdge => ({
    id: `${kind}:${from}->${to}`,
    kind,
    from,
    to,
    eventTypes,
    label: eventTypes.join(', '),
    volume24h,
    recent,
    enabled,
  });

  const toBoardSource = (s: SourceSummary) => ({
    id: s.id,
    name: s.name,
    typeId: s.typeId,
    typeName: s.typeName,
    typeIcon: s.typeIcon,
    status: s.status,
    enabled: s.enabled,
    lastEventAt: s.lastEventAt,
    events24h: s.eventsByType24h.reduce((n, t) => n + t.count, 0),
    pluginAvailable: s.pluginAvailable,
    unauthenticated: s.unauthenticated,
  });

  const board: BoardResponse = {
    sources: sources.map(toBoardSource),
    processes: processes.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      enabled: p.enabled,
      breakerOpen: p.breakerState === 'open',
      awaitingApproval: p.awaitingApproval,
      dots: p.dots,
      nextSweepAt: p.nextSweepAt,
      runs24h: p.dailyCap.used,
      lastRunAt: p.lastRunAt,
    })),
    destinations: destinations.map((x) => ({
      id: x.id,
      name: x.name,
      typeId: x.typeId,
      typeName: x.typeName,
      typeIcon: x.typeIcon,
      status: x.status,
      enabled: x.enabled,
      meters: x.meters,
      softHoldUntil: x.softHoldUntil,
    })),
    edges: [
      edge('trigger', S.linear, P.triage, 168, 3, ['issue.created', 'issue.label_added']),
      edge('trigger', S.linear, P.sizer, 96, 1, ['issue.state_changed']),
      edge('trigger', S.linear, P.autofix, 121, 2, ['issue.label_added', 'issue.state_changed']),
      edge('trigger', S.github, P.prReview, 38, 1, ['pull_request.opened']),
      edge('trigger', S.github, P.merge, 12, 0, ['check_suite.completed']),
      edge('trigger', S.github, P.flaky, 16, 0, ['check_suite.completed']),
      edge('trigger', S.github, P.depBumps, 0, 0, ['pull_request.opened'], false),
      edge('trigger', S.datadog, P.ddMiner, 19, 0, ['error.issue_new']),
      edge('trigger', S.datadog, P.triage, 8, 0, ['error.issue_new']),
      edge('trigger', S.braintrust, P.sentiment, 0, 0, ['session.low_score']),
      edge('binding', P.triage, E.routines, 6, 1),
      edge('binding', P.sizer, E.routines, 3, 0),
      edge('binding', P.autofix, E.routines, 3, 1),
      edge('binding', P.prReview, E.actions, 4, 1),
      edge('binding', P.merge, E.http, 1, 0),
      edge('binding', P.ddMiner, E.routines, 1, 0),
      edge('binding', P.sentiment, E.routines, 0, 0),
      edge('binding', P.flaky, E.actions, 2, 0),
      edge('binding', P.depBumps, E.actions, 0, 0, [], false),
      edge('binding', P.scorecard, E.routines, 0, 0),
      edge('binding', P.nightly, E.routines, 1, 0),
    ],
    attention: [
      {
        id: 'att-breaker-autofix',
        kind: 'breaker',
        tone: 'error',
        title: 'Autofix breaker open',
        detail: '3 errors in 46 min · cooldown ends in 46 min',
        targetKind: 'process',
        targetId: P.autofix,
        action: { id: 'reset_breaker', label: 'Reset' },
        since: iso(-14 * MIN),
      },
      {
        id: 'att-unhealthy-github',
        kind: 'unhealthy',
        tone: 'error',
        title: 'GitHub — acme org · auth failure',
        detail: 'token refresh failed 50 min ago',
        targetKind: 'source',
        targetId: S.github,
        action: { id: 'reload', label: 'Reload' },
        since: iso(-50 * MIN),
      },
      {
        id: 'att-approval-merge',
        kind: 'approval',
        tone: 'warn',
        title: 'Merge · batch awaiting approval',
        detail: '#480 · waiting 32 min',
        targetKind: 'approval',
        targetId: 'b-merge-480',
        action: { id: 'approve', label: 'Approve' },
        since: iso(-32 * MIN),
      },
      {
        id: 'att-stale-weekly',
        kind: 'meter_stale',
        tone: 'warn',
        title: 'Claude Routines · weekly window stale',
        detail: 'last read 42 min ago',
        targetKind: 'destination',
        targetId: E.routines,
        action: { id: 'read_meters', label: 'Read meters' },
        since: iso(-42 * MIN),
      },
      {
        id: 'att-silent-braintrust',
        kind: 'source_silent',
        tone: 'warn',
        title: 'Braintrust silent for 26 h',
        detail: 'usually 6–10 a day',
        targetKind: 'source',
        targetId: S.braintrust,
        action: { id: 'test_event', label: 'Test event' },
        since: iso(-26 * HOUR),
      },
      {
        id: 'att-plugin-braintrust',
        kind: 'plugin_unavailable',
        tone: 'warn',
        title: '@lola/switchboard-source-braintrust unavailable',
        detail: 'declares sdk ^0.8, running 1.4.2',
        targetKind: 'plugin',
        targetId: '@lola/switchboard-source-braintrust',
        action: { id: 'open', label: 'Plugins' },
        since: iso(-3 * DAY),
      },
    ],
    generatedAt: iso(0),
  };

  const sourceStats: SourceStatsResponse = {
    window: '24h',
    buckets: hours.map((hour, i) => {
      const v = shape[i] ?? 0;
      return {
        hour,
        byType: {
          'issue.label_added': Math.round(v * 0.12),
          'issue.state_changed': Math.round(v * 0.07),
          'comment.created': Math.round(v * 0.03),
        },
        byStage: { matched: Math.round(v * 0.17), unmatched: Math.round(v * 0.05) },
      };
    }),
    verifyFailures: [{ hour: iso(-5 * HOUR), count: 2 }],
  };

  const lastDelivery: LastDeliveryResponse = {
    receivedAt: iso(-2 * HOUR),
    body: JSON.stringify(
      {
        id: 'dep_48213',
        service: 'api',
        environment: 'production',
        status: 'success',
        deployment: { id: 'dep_48213', updated_at: '2026-09-27T10:14:06Z' },
        tags: ['team:payments'],
      },
      null,
      2,
    ),
    headers: {
      'content-type': 'application/json',
      'x-delivery-id': '7f3a9c1e-2b44-4d0a-9d4f-8e1b2a6c5d01',
      'x-signature-256': '[redacted]',
    },
  };

  const meterHistory: MeterHistoryResponse = {
    window: '7d',
    meters: [
      {
        id: 'five_hour',
        title: '5-hour window',
        estimated: false,
        readings: Array.from({ length: 84 }, (_, i) => ({
          t: iso(-(83 - i) * 2 * HOUR),
          utilization: Math.round(35 + 30 * Math.sin(i / 3) + (i % 7) * 2),
          resetsAt: null,
        })),
        ceilings: fiveHour.ceilings,
      },
      {
        id: 'weekly',
        title: 'weekly window',
        estimated: false,
        readings: Array.from({ length: 84 }, (_, i) => ({
          t: iso(-(83 - i) * 2 * HOUR),
          utilization: Math.round(8 + i * 0.4),
          resetsAt: null,
        })),
        ceilings: weekly.ceilings,
      },
    ],
    runs: runs.map((r) => ({
      t: r.invokedAt ?? iso(0),
      runId: r.id,
      processId: r.processId,
      processName: r.processName,
      status: r.status,
      statusLabel: runStatusLabel(r.status),
    })),
  };

  const usageHistory: UsageHistoryResponse = {
    window: '7d',
    dimensions: [
      {
        id: 'input_tokens',
        title: 'Input tokens',
        unit: 'tokens',
        days: days.map((day, i) => ({
          day,
          value: ([310, 420, 380, 520, 290, 250, 610][i] ?? 0) * 1000,
        })),
      },
      {
        id: 'duration_seconds',
        title: 'Duration',
        unit: 'seconds',
        days: days.map((day, i) => ({
          day,
          value: [3100, 4200, 3900, 4800, 2600, 2300, 6100][i] ?? 0,
        })),
      },
    ],
    runsByStatus: days.map((day, i) => ({
      day,
      counts: { ok: 8 + (i % 3), error: i === 6 ? 3 : 0 },
    })),
  };

  const pluginTypes: PluginTypeDTO[] = [
    {
      kind: 'source',
      typeId: 'linear',
      displayName: 'Linear',
      icon: 'issue',
      plugin: '@ai-switchboard/source-linear',
      available: true,
      settingsSchema: linearSettingsSchema,
      mode: 'both',
      eventTypes: sourceDetail(at(sources, 1)).eventTypes,
      provisionSupported: true,
    },
    {
      kind: 'source',
      typeId: 'github',
      displayName: 'GitHub',
      icon: 'pr',
      plugin: '@ai-switchboard/source-github',
      available: true,
      settingsSchema: githubSettingsSchema,
      mode: 'push',
      eventTypes: [],
      provisionSupported: true,
    },
    {
      kind: 'source',
      typeId: 'webhook',
      displayName: 'Webhook',
      icon: 'webhook',
      plugin: '@ai-switchboard/source-webhook',
      available: true,
      settingsSchema: webhookSettingsSchema,
      mode: 'push',
      eventTypes: [],
      dynamicEventTypes: true,
      allowsUnauthenticated: true,
    },
    {
      kind: 'source',
      typeId: 'datadog',
      displayName: 'Datadog',
      icon: 'alert',
      plugin: '@ai-switchboard/source-datadog',
      available: true,
      settingsSchema: datadogSettingsSchema,
      mode: 'pull',
      eventTypes: [],
    },
    {
      kind: 'destination',
      typeId: 'claude-routines',
      displayName: 'Claude Routines',
      icon: 'run',
      plugin: '@ai-switchboard/destination-claude-routines',
      available: true,
      settingsSchema: routinesSettingsSchema,
      targetSchema: routinesTargetSchema,
      inputSchema: routinesInputSchema,
      tracking: 'callback',
      idempotentInvoke: false,
      meters: destinationDetail(at(destinations, 0)).meterSpecs,
    },
    {
      kind: 'destination',
      typeId: 'http',
      displayName: 'HTTP',
      icon: 'link',
      plugin: '@ai-switchboard/destination-http',
      available: true,
      settingsSchema: httpSettingsSchema,
      targetSchema: httpTargetSchema,
      inputSchema: httpInputSchema,
      tracking: 'sync',
      idempotentInvoke: true,
    },
    {
      kind: 'notifier',
      typeId: 'slack',
      displayName: 'Slack',
      icon: 'alert',
      plugin: '@ai-switchboard/notifier-slack',
      available: true,
      settingsSchema: slackSettingsSchema,
    },
    {
      kind: 'secret_provider',
      typeId: 'env',
      displayName: 'Environment',
      icon: 'key',
      plugin: '@ai-switchboard/secrets-env',
      available: true,
      settingsSchema: envSettingsSchema,
    },
    {
      kind: 'secret_provider',
      typeId: 'file',
      displayName: 'File',
      icon: 'lock',
      plugin: '@ai-switchboard/secrets-file',
      available: true,
      settingsSchema: fileSettingsSchema,
    },
  ];

  const plugin = (
    name: string,
    displayName: string,
    version: string,
    types: PluginSummary['types'],
    extra: Partial<PluginSummary> = {},
  ): PluginSummary => ({
    name,
    pluginId: name.split('/').pop() ?? name,
    displayName,
    version,
    status: 'loaded',
    statusLabel: st('ok', 'loaded'),
    statusMessage: null,
    origin: 'baked',
    sdkRange: '^2.0.0',
    capabilities: { network: [], secrets: [] },
    types,
    errorCount: 0,
    invalidEventCount: 0,
    integrity: null,
    pendingRestart: false,
    ...extra,
  });
  const plugins: PluginSummary[] = [
    plugin(
      '@ai-switchboard/source-github',
      'GitHub',
      '1.4.2',
      [{ kind: 'source', typeId: 'github', displayName: 'GitHub', instanceCount: 1 }],
      { capabilities: { network: ['api.github.com'], secrets: ['GITHUB_*'] } },
    ),
    plugin(
      '@ai-switchboard/source-linear',
      'Linear',
      '1.4.2',
      [{ kind: 'source', typeId: 'linear', displayName: 'Linear', instanceCount: 1 }],
      { capabilities: { network: ['api.linear.app'], secrets: ['LINEAR_*'] } },
    ),
    plugin(
      '@ai-switchboard/destination-claude-routines',
      'Claude Routines',
      '0.9.1',
      [
        {
          kind: 'destination',
          typeId: 'claude-routines',
          displayName: 'Claude Routines',
          instanceCount: 1,
        },
      ],
      {
        statusLabel: st('warn', '2 invalid usage keys · 24 h'),
        invalidEventCount: 2,
        capabilities: { network: ['api.anthropic.com'], secrets: ['CLAUDE_*'] },
      },
    ),
    plugin(
      '@lola/switchboard-source-braintrust',
      'Braintrust',
      '0.3.0',
      [{ kind: 'source', typeId: 'braintrust', displayName: 'Braintrust', instanceCount: 1 }],
      {
        status: 'incompatible',
        statusLabel: st('error', 'unavailable · failed to load'),
        statusMessage: 'declares sdk ^0.8, running 1.4.2',
        origin: 'installed',
        sdkRange: '^0.8.0',
        capabilities: { network: ['api.braintrust.dev'], secrets: ['BRAINTRUST_*'] },
      },
    ),
  ];
  const catalogue: CatalogueEntry[] = [
    {
      package: '@ai-switchboard/source-sentry',
      displayName: 'Sentry',
      description: 'Issues and alerts from Sentry as events.',
      kinds: ['source'],
      reviewed: true,
      installed: false,
      latestVersion: '1.2.0',
      homepage: 'https://github.com/ai-switchboard/switchboard',
    },
    {
      package: '@ai-switchboard/source-linear',
      displayName: 'Linear',
      description: 'Issues, labels and comments from Linear.',
      kinds: ['source'],
      reviewed: true,
      installed: true,
      latestVersion: '1.4.2',
    },
  ];

  const searchResult = (
    pkg: string,
    kind: PluginSearchResult['kind'],
    version: string,
    description: string,
    extra: Partial<PluginSearchResult> = {},
  ): PluginSearchResult => ({
    package: pkg,
    kind,
    version,
    description,
    publisher: 'switchboard-bot',
    date: '2026-02-20T09:00:00.000Z',
    links: { npm: `https://www.npmjs.com/package/${pkg}` },
    weeklyDownloads: 1200,
    installed: false,
    installedVersion: null,
    reviewed: false,
    ...extra,
  });
  const pluginSearch: PluginSearchResult[] = [
    searchResult(
      '@ai-switchboard/source-sentry',
      'source',
      '1.2.0',
      'Issues and alerts from Sentry as events.',
      {
        reviewed: true,
        links: {
          npm: 'https://www.npmjs.com/package/@ai-switchboard/source-sentry',
          homepage: 'https://github.com/ai-switchboard/switchboard',
        },
      },
    ),
    searchResult(
      '@ai-switchboard/source-linear',
      'source',
      '1.4.2',
      'Issues, labels and comments from Linear.',
      {
        reviewed: true,
        installed: true,
        installedVersion: '1.4.2',
      },
    ),
    searchResult(
      '@acme/ai-switchboard-source-jira',
      'source',
      '0.4.1',
      'Jira issue transitions and comments.',
      {
        publisher: 'acme-dev',
        weeklyDownloads: 85,
      },
    ),
    searchResult(
      'ai-switchboard-destination-n8n',
      'destination',
      '2.0.0',
      'Start n8n executions and track them.',
      {
        publisher: 'n8n-community',
        weeklyDownloads: null,
      },
    ),
  ];

  const notifiers: InstanceSummary[] = [
    {
      id: 'n-slack',
      kind: 'notifier',
      typeId: 'slack',
      typeName: 'Slack',
      typeIcon: 'alert',
      name: 'Slack — #loops',
      enabled: true,
      status: st('ok', 'ok'),
      health: health('healthy'),
      settings: { webhookUrl: 'secret://env/SLACK_WEBHOOK_URL', channel: '#loops' },
      settingsSchema: slackSettingsSchema,
      instanceError: null,
    },
  ];
  const secretProviders: InstanceSummary[] = [
    {
      id: 'sp-env',
      kind: 'secret_provider',
      typeId: 'env',
      typeName: 'Environment',
      typeIcon: 'key',
      name: 'env',
      enabled: true,
      status: st('ok', 'ok'),
      health: health('healthy'),
      settings: {},
      settingsSchema: envSettingsSchema,
      instanceError: null,
      dependents: [
        {
          kind: 'destination',
          id: E.routines,
          name: 'Claude Routines — automation seat',
          status: st('ok', 'ok'),
          instanceError: null,
        },
      ],
    },
    {
      id: 'sp-file',
      kind: 'secret_provider',
      typeId: 'file',
      typeName: 'File',
      typeIcon: 'lock',
      name: 'file — /var/run/secrets',
      enabled: true,
      status: st('ok', 'ok'),
      health: health('healthy'),
      settings: { directory: '/var/run/secrets' },
      settingsSchema: fileSettingsSchema,
      instanceError: null,
      dependents: [],
    },
  ];
  // Names only, never values.
  const providerSecrets: Record<string, ProviderSecretsResponse> = {
    'sp-env': {
      providerId: 'sp-env',
      provider: 'env',
      available: true,
      secrets: [
        {
          name: 'CLAUDE_API_KEY',
          ref: 'secret://env/CLAUDE_API_KEY',
          usedBy: [
            {
              kind: 'destination',
              id: E.routines,
              name: 'Claude Routines — automation seat',
              field: 'token',
            },
          ],
        },
        {
          name: 'LINEAR_API_KEY',
          ref: 'secret://env/LINEAR_API_KEY',
          usedBy: [{ kind: 'source', id: S.linear, name: 'Linear — lola', field: 'apiKey' }],
        },
        {
          name: 'LINEAR_WEBHOOK_SECRET',
          ref: 'secret://env/LINEAR_WEBHOOK_SECRET',
          usedBy: [{ kind: 'source', id: S.linear, name: 'Linear — lola', field: 'webhookSecret' }],
        },
        {
          name: 'SLACK_WEBHOOK_URL',
          ref: 'secret://env/SLACK_WEBHOOK_URL',
          usedBy: [
            { kind: 'notifier', id: 'n-slack', name: 'Slack — #loops', field: 'webhookUrl' },
          ],
        },
        { name: 'SPARE_TOKEN', ref: 'secret://env/SPARE_TOKEN', usedBy: [] },
      ],
      missing: [
        {
          name: 'LOOPS_ROUTINE_TOKEN_AUTOFIX',
          ref: 'secret://env/LOOPS_ROUTINE_TOKEN_AUTOFIX',
          usedBy: [
            { kind: 'process', id: P.autofix, name: 'Autofix', field: 'destination.target.token' },
          ],
        },
      ],
    },
    'sp-file': {
      providerId: 'sp-file',
      provider: 'file',
      available: true,
      secrets: [
        {
          name: 'github-app-key',
          ref: 'secret://file/github-app-key',
          updatedAt: iso(-3 * DAY),
          usedBy: [],
        },
        {
          name: `switchboard-${E.routines}-oauthRefreshToken`,
          ref: `secret://file/switchboard-${E.routines}-oauthRefreshToken`,
          updatedAt: iso(-2 * HOUR),
          usedBy: [],
          storedBy: {
            kind: 'destination',
            id: E.routines,
            name: 'Claude Routines — automation seat',
          },
        },
      ],
      missing: [],
    },
  };
  const settings: GlobalSettings = {
    timezone: 'America/New_York',
    defaultQuietHours: { start: '22:00', end: '07:00' },
    meterStalenessMinutes: 15,
    retention: {
      eventsDays: 30,
      rawBodiesDays: 7,
      dispatchesDays: 30,
      meterReadingsDays: 30,
      statsHourlyDays: 90,
    },
    oidc: null,
    systemNotifierId: 'n-slack',
    sourceSilenceMinutes: 720,
    requireReasons: true,
    export: {
      schedule: '55 23 * * *',
      sourceId: S.github,
      repository: 'acme/switchboard-config',
      path: 'switchboard.yaml',
      branch: 'main',
    },
  };
  const users: UserDTO[] = [
    { ...user, role: 'admin' },
    {
      id: 'u-daria',
      email: 'daria@lola.com',
      role: 'operator',
      hasPassword: false,
      hasOidc: true,
      mustChangePassword: false,
      lastLoginAt: iso(-1 * DAY),
      createdAt: iso(-80 * DAY),
    },
    {
      id: 'u-priya',
      email: 'priya@lola.com',
      role: 'operator',
      hasPassword: true,
      hasOidc: true,
      mustChangePassword: false,
      lastLoginAt: iso(-3 * DAY),
      createdAt: iso(-60 * DAY),
    },
    {
      id: 'u-sam',
      email: 'sam@lola.com',
      role: 'viewer',
      hasPassword: true,
      hasOidc: false,
      mustChangePassword: true,
      lastLoginAt: null,
      createdAt: iso(-5 * DAY),
    },
  ];
  const tokens: ApiTokenDTO[] = [
    {
      id: 'tok-ci',
      name: 'CI apply',
      role: 'operator',
      createdAt: iso(-40 * DAY),
      lastUsedAt: iso(-1 * DAY),
      revokedAt: null,
    },
  ];
  const audit: AuditEntry[] = [
    {
      id: 3012,
      at: iso(-1 * DAY),
      actor: 'ilya@lola.com',
      scope: 'process',
      targetId: P.autofix,
      targetName: 'Autofix',
      field: 'budgets.runsPerHour',
      before: 4,
      after: 2,
      reason: 'lower runs per hour to 2',
    },
    {
      id: 3011,
      at: iso(-2 * DAY),
      actor: 'daria@lola.com',
      scope: 'source',
      targetId: S.slack,
      targetName: 'Slack — Events API',
      field: 'enabled',
      before: true,
      after: false,
      reason: 'moving to the Events API app',
    },
  ];
  const about: AboutResponse = {
    version: '0.4.1',
    sdkVersion: '1.4.2',
    replicas: [
      {
        id: 'sw-1',
        hostname: 'sw-1',
        version: '0.4.1',
        startedAt: iso(-3 * DAY),
        heartbeatAt: iso(-5000),
        live: true,
      },
      {
        id: 'sw-2',
        hostname: 'sw-2',
        version: '0.4.1',
        startedAt: iso(-3 * DAY),
        heartbeatAt: iso(-7000),
        live: true,
      },
    ],
    database: { ok: true, version: '16.4' },
    plugins: plugins.length,
    evaluation: true,
    publicUrl: 'https://switchboard.lola.com',
    telemetry: {
      enabled: true,
      serviceName: 'switchboard',
      prometheus: true,
      signals: [
        {
          signal: 'traces',
          exporters: ['otlp'],
          protocol: 'http/protobuf',
          endpoint: 'http://otel-collector:4318',
          headers: 1,
        },
        {
          signal: 'metrics',
          exporters: ['otlp'],
          protocol: 'http/protobuf',
          endpoint: 'http://otel-collector:4318',
          headers: 1,
        },
        { signal: 'logs', exporters: [], protocol: null, endpoint: null, headers: 0 },
      ],
      sampler: 'parentbased_always_on',
    },
  };

  const filterPreview: FilterPreviewResponse = {
    rows: [
      ['LOL-1712', 'autofix · complexity:simple', true, 23],
      ['LOL-1709', 'autofix · complexity:medium', false, 38],
      ['LOL-1701', 'autofix · complexity:simple', true, 57],
      ['LOL-1699', 'autofix · complexity:simple', true, 63],
      ['LOL-1716', 'bug · no autofix', false, 79],
    ].map(([id, summaryText, result, ago], i) => ({
      eventId: `ev-prev-${i}`,
      type: 'issue.label_added',
      occurredAt: iso(-Number(ago) * MIN),
      artifact: {
        kind: 'linear.issue',
        id: String(id),
        url: `https://linear.app/lola/issue/${String(id)}`,
      },
      attributes: { label: String(summaryText) },
      result: Boolean(result),
    })),
  };
  const inputPreview: InputPreviewResponse = {
    input: { text: 'run 01J8KQ4…Q4 · mode event · fix LOL-1712 · complexity:simple' },
    valid: true,
    errors: [],
  };
  const cronPreview: CronPreviewResponse = {
    valid: true,
    description: 'At 07:00 AM',
    next: [
      nextAt(7),
      iso(new Date(nextAt(7)).getTime() - now + DAY),
      iso(new Date(nextAt(7)).getTime() - now + 2 * DAY),
    ],
  };

  return {
    now,
    me,
    user,
    status,
    board,
    sources,
    sourceDetail,
    sourceStats,
    lastDelivery,
    destinations,
    destinationDetail,
    meterHistory,
    usageHistory,
    processes,
    processDetail,
    autofixDocument,
    funnel,
    processStats,
    versions,
    versionDocument,
    batches,
    activity,
    eventDetail,
    trace,
    runs,
    runDetail,
    approvals,
    approvalHistory,
    approvalRules,
    pluginTypes,
    plugins,
    catalogue,
    pluginSearch,
    notifiers,
    secretProviders,
    providerSecrets,
    settings,
    users,
    tokens,
    audit,
    about,
    filterPreview,
    inputPreview,
    cronPreview,
  };
}

export type Fixtures = ReturnType<typeof buildFixtures>;

/** The Board's first-run state. */
export function emptyBoard(now: number): BoardResponse {
  return {
    sources: [],
    processes: [],
    destinations: [],
    edges: [],
    attention: [],
    generatedAt: new Date(now).toISOString(),
  };
}
