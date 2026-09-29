export const RUN_ID = 9_876_543_210;
export const SWITCHBOARD_RUN = '00000000-0000-4000-8000-000000000001';

export function workflowRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    name: SWITCHBOARD_RUN,
    display_title: SWITCHBOARD_RUN,
    event: 'workflow_dispatch',
    status: 'in_progress',
    conclusion: null,
    workflow_id: 161_335,
    html_url: `https://github.com/acme/api/actions/runs/${RUN_ID}`,
    created_at: '2026-09-27T10:00:03Z',
    run_started_at: '2026-09-27T10:00:05Z',
    updated_at: '2026-09-27T10:04:05Z',
    ...overrides,
  };
}

export function runList(runs: Record<string, unknown>[]): Record<string, unknown> {
  return { total_count: runs.length, workflow_runs: runs };
}

export const dispatchDetails = {
  workflow_run_id: RUN_ID,
  run_url: `https://api.github.com/repos/acme/api/actions/runs/${RUN_ID}`,
  html_url: `https://github.com/acme/api/actions/runs/${RUN_ID}`,
};

export const timing = {
  billable: {
    UBUNTU: {
      total_ms: 185_000,
      jobs: 3,
      job_runs: [
        { job_id: 1, duration_ms: 61_000 },
        { job_id: 2, duration_ms: 4_000 },
        { job_id: 3, duration_ms: 120_000 },
      ],
    },
    MACOS: { total_ms: 90_000, jobs: 1 },
  },
  run_duration_ms: 240_000,
};

export const jobs = { total_count: 4, jobs: [{ id: 1, name: 'lint' }] };

export const rateLimit = {
  resources: {
    core: { limit: 5000, used: 1250, remaining: 3750, reset: 1_790_500_000 },
    search: { limit: 30, used: 0, remaining: 30, reset: 1_790_500_000 },
  },
  rate: { limit: 5000, used: 1250, remaining: 3750, reset: 1_790_500_000 },
};

export const installationToken = {
  token: 'ghs_fixtureInstallationToken',
  expires_at: '2026-09-27T11:00:00Z',
  permissions: { actions: 'write', contents: 'read' },
};
