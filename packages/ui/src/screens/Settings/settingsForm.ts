import type { GlobalSettings, Role } from '@ai-switchboard/core/contract';

import { ROLE_RANK } from '../../app/session.js';

export function timezones(): string[] {
  const intl = Intl as { supportedValuesOf?: (key: string) => string[] };
  try {
    const list = intl.supportedValuesOf?.('timeZone');
    if (list && list.length > 0) return list;
  } catch {
    // Older engines: fall through to the short list.
  }
  return ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin'];
}

export type GeneralDraft = Pick<
  GlobalSettings,
  | 'timezone'
  | 'defaultQuietHours'
  | 'meterStalenessMinutes'
  | 'sourceSilenceMinutes'
  | 'systemNotifierId'
  | 'requireReasons'
>;

export function generalDraft(s: GlobalSettings): GeneralDraft {
  return {
    timezone: s.timezone,
    defaultQuietHours: s.defaultQuietHours,
    meterStalenessMinutes: s.meterStalenessMinutes,
    sourceSilenceMinutes: s.sourceSilenceMinutes,
    systemNotifierId: s.systemNotifierId,
    requireReasons: s.requireReasons,
  };
}

export function changedFields<T extends object>(saved: T, draft: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(draft) as (keyof T)[]) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(draft[key])) out[key] = draft[key];
  }
  return out;
}

export function parsePositiveInt(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text);
  return n > 0 ? n : null;
}

export function grantableRoles(own: Role): Role[] {
  return (['viewer', 'operator', 'admin'] as const).filter((r) => ROLE_RANK[r] <= ROLE_RANK[own]);
}

export function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export function parseDomains(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}
