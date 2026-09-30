import type { QuietWindow } from './process.js';

export interface RetentionSettings {
  eventsDays: number;
  rawBodiesDays: number;
  dispatchesDays: number;
  meterReadingsDays: number;
  statsHourlyDays: number;
}

export interface GlobalSettings {
  timezone: string;
  /** In the installation timezone. */
  defaultQuietHours: Omit<QuietWindow, 'timezone'> | null;
  meterStalenessMinutes: number;
  retention: RetentionSettings;
  oidc: { issuer: string; clientId: string; allowedDomains: string[] } | null;
  systemNotifierId: string | null;
  sourceSilenceMinutes: number;
  /**
   * Default true. When false, a missing reason is audited as "(no reason given)". Other replicas
   * apply a change within a few seconds.
   */
  requireReasons: boolean;
  export: {
    schedule: string | null;
    sourceId: string | null;
    repository: string | null;
    path: string | null;
    branch: string | null;
  };
}

export const DEFAULT_SETTINGS: GlobalSettings = {
  timezone: 'UTC',
  defaultQuietHours: null,
  meterStalenessMinutes: 30,
  retention: {
    eventsDays: 90,
    rawBodiesDays: 30,
    dispatchesDays: 90,
    meterReadingsDays: 90,
    statsHourlyDays: 730,
  },
  oidc: null,
  systemNotifierId: null,
  sourceSilenceMinutes: 1440,
  requireReasons: true,
  export: { schedule: null, sourceId: null, repository: null, path: null, branch: null },
};

/** Nested groups merge key by key, so a patch of one retention field keeps the others. */
export function mergeSettings(
  base: GlobalSettings,
  patch: Partial<GlobalSettings>,
): GlobalSettings {
  return {
    ...base,
    ...patch,
    retention: { ...base.retention, ...patch.retention },
    export: { ...base.export, ...patch.export },
  };
}
