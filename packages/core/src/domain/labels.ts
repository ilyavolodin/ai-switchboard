import type { Health } from '@ai-switchboard/sdk';

import type { PluginStatus, RunStatusValue, StatusTone } from './status.js';

export interface StatusLabel {
  tone: StatusTone;
  label: string;
}

export const RUN_STATUS_LABELS: Record<RunStatusValue, StatusLabel> = {
  invoking: { tone: 'ok', label: 'invoking' },
  running: { tone: 'ok', label: 'running' },
  uncertain: { tone: 'warn', label: 'uncertain' },
  ok: { tone: 'ok', label: 'ok' },
  error: { tone: 'error', label: 'error' },
  failed: { tone: 'error', label: 'failed' },
  unknown: { tone: 'warn', label: 'unknown' },
  held: { tone: 'warn', label: 'held' },
};

export function runStatusLabel(status: RunStatusValue): StatusLabel {
  return RUN_STATUS_LABELS[status];
}

export function instanceStatus(input: {
  enabled: boolean;
  health: Health | null;
  instanceError: string | undefined;
  stale?: boolean;
  softHold?: boolean;
}): StatusLabel {
  if (input.instanceError === 'plugin_unavailable')
    return { tone: 'warn', label: 'plugin unavailable' };
  if (!input.enabled) return { tone: 'off', label: 'disabled' };
  if (input.instanceError?.startsWith('secret_error'))
    return { tone: 'error', label: 'secret error' };
  if (input.instanceError?.startsWith('create_failed'))
    return { tone: 'error', label: 'failed to start' };
  if (input.health?.status === 'unhealthy') return { tone: 'error', label: 'unhealthy' };
  if (input.softHold) return { tone: 'warn', label: 'soft-hold' };
  if (input.stale) return { tone: 'warn', label: 'stale' };
  if (input.health?.status === 'healthy') return { tone: 'ok', label: 'healthy' };
  return { tone: 'ok', label: 'enabled' };
}

export function processStatus(input: {
  enabled: boolean;
  breakerOpen: boolean;
  awaitingApproval: number;
  lastRunStatus: RunStatusValue | null;
  held?: boolean;
}): StatusLabel {
  if (input.breakerOpen) return { tone: 'error', label: 'breaker open' };
  if (!input.enabled) return { tone: 'off', label: 'disabled' };
  if (input.awaitingApproval > 0) return { tone: 'warn', label: 'awaiting approval' };
  if (input.held) return { tone: 'warn', label: 'held' };
  if (input.lastRunStatus === null) return { tone: 'off', label: 'not yet run' };
  if (input.lastRunStatus === 'error' || input.lastRunStatus === 'failed')
    return { tone: 'error', label: 'last run failed' };
  return { tone: 'ok', label: 'flowing' };
}

export function pluginStatusLabel(status: PluginStatus): StatusLabel {
  switch (status) {
    case 'loaded':
      return { tone: 'ok', label: 'loaded' };
    case 'unavailable':
      return { tone: 'warn', label: 'unavailable' };
    case 'incompatible':
      return { tone: 'error', label: 'incompatible' };
    case 'failed':
      return { tone: 'error', label: 'failed' };
  }
}
